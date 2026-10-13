import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { OwnerHost } from "./owner.js";
import { HostClient, socketPath, startHostServer } from "./rpc.js";
import { canonicalPath, protections, withinPath } from "./sandbox.js";

test("long Unicode data paths use a private short socket and clean up on close", async () => {
  const data = `/tmp/${"很长的数据目录/".repeat(20)}${randomUUID()}`;
  const host = { call: vi.fn(async () => ({ ok: true })), close: vi.fn() };
  expect(Buffer.byteLength(socketPath(data))).toBeLessThan(104);
  expect(socketPath(`${data}/other`)).not.toBe(socketPath(data));
  const server = await startHostServer(data, host as unknown as OwnerHost);
  try {
    const protectedPaths = await protections(data);
    const canonicalSocket = await canonicalPath(socketPath(data));
    expect(protectedPaths.private.some((path) => withinPath(path, canonicalSocket))).toBe(true);
    expect((await lstat(socketPath(data))).mode & 0o777).toBe(0o600);
    expect(await new HostClient(data).call("ping", {})).toEqual({ ok: true });
    await expect(startHostServer(data, host as unknown as OwnerHost)).rejects.toThrow("已有宿主");
  } finally {
    await server.close();
  }
  expect(host.close).toHaveBeenCalledOnce();
  await expect(lstat(socketPath(data))).rejects.toMatchObject({ code: "ENOENT" });
});

test("downloads raw binary beyond preview/RPC limits and closes cancelled streams", async () => {
  const dir = await mkdtemp(join(tmpdir(), "intrica-download-test-"));
  const host = new OwnerHost(dir),
    server = await startHostServer(dir, host);
  try {
    const body = Buffer.alloc(33 * 1024 * 1024, 123);
    body[0] = 0;
    const path = join(dir, "最终产物.bin");
    await writeFile(path, body);
    const client = new HostClient(dir);
    const file = await client.download(path, new AbortController().signal);
    expect(file.name).toBe("最终产物.bin");
    expect(file.size).toBe(body.length);
    const chunks = [];
    for await (const chunk of file.stream) chunks.push(chunk);
    const received = Buffer.concat(chunks);
    expect(received.length).toBe(body.length);
    expect(createHash("sha256").update(received).digest("hex")).toBe(
      createHash("sha256").update(body).digest("hex"),
    );
    await expect(client.download(dir, new AbortController().signal)).rejects.toThrow("普通文件");
    const abort = new AbortController(),
      cancelled = await client.download(path, abort.signal);
    abort.abort();
    await expect.poll(() => cancelled.stream.destroyed).toBe(true);
    expect(await client.call("ping", {})).toMatchObject({ ready: true });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("scoped commands cannot connect to the private owner RPC socket", async (context) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdir, realpath, symlink } = await import("node:fs/promises");
  const { buildSandboxCommand, cleanEnvironment } = await import("./sandbox.js");
  const root = await realpath(await mkdtemp(join(tmpdir(), "intrica-rpc-isolation-")));
  const home = join(root, "workspace");
  await mkdir(join(home, ".tmp"), { recursive: true });
  const call = vi.fn(async () => ({ marker: "fixture-only-owner-authority" }));
  const server = await startHostServer(root, { call, close: vi.fn() } as unknown as OwnerHost);
  try {
    await symlink(socketPath(root), join(home, "owner-alias.sock"));
    const program = `import{createConnection}from'node:net';import{link}from'node:fs/promises';const probe=path=>new Promise(resolve=>{const socket=createConnection(path);socket.on('error',e=>resolve(true));socket.on('connect',()=>socket.write(JSON.stringify({method:'ping',args:{}})+'\\n'));socket.on('data',()=>{resolve(false);socket.destroy();});});let hardlinkBlocked=true;try{await link(${JSON.stringify(socketPath(root))},${JSON.stringify(join(home, "hardlink.sock"))});hardlinkBlocked=await probe(${JSON.stringify(join(home, "hardlink.sock"))});}catch{}console.log(JSON.stringify({blocked:await probe(${JSON.stringify(socketPath(root))}),aliasBlocked:await probe(${JSON.stringify(join(home, "owner-alias.sock"))}),hardlinkBlocked}));`;
    const spec = await buildSandboxCommand(
      process.execPath,
      ["--input-type=module", "-e", program],
      [{ path: home, directory: true, write: true }],
      home,
      root,
    );
    if (!spec) return context.skip("Platform isolation unavailable");
    const output = await promisify(execFile)(spec.command, spec.args, {
      cwd: home,
      env: cleanEnvironment(home),
      timeout: 5000,
    }).catch((error) => {
      if (
        process.platform === "linux" &&
        /bwrap:[^\n]*(?:namespace|unshare)/i.test(String(error)) &&
        /operation not permitted|permission denied/i.test(String(error))
      ) {
        context.skip("Host disables bubblewrap user namespaces");
        return null;
      }
      throw error;
    });
    if (!output) return;
    expect(JSON.parse(output.stdout)).toEqual({
      blocked: true,
      aliasBlocked: true,
      hardlinkBlocked: true,
    });
    expect(call).not.toHaveBeenCalled();
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
