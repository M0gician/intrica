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
