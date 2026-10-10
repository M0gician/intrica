import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { buildSandboxCommand, cleanEnvironment } from "./sandbox.js";

const execute = promisify(execFile);

test("isolated commands resolve host names and reach the host network while preserving file boundaries", async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "intrica-network-")));
  const outside = await realpath(await mkdtemp(join(tmpdir(), "intrica-outside-")));
  const workspace = join(root, "workspace");
  const secret = join(root, "secrets", "secret.txt");
  const readOnly = join(root, "assets", "published.txt");
  const outsideFile = join(outside, "private.txt");
  const ownFile = join(workspace, "download.txt");
  const marker = randomUUID();
  const server = createServer((_request, response) => response.end(marker));
  try {
    await mkdir(join(workspace, ".tmp"), { recursive: true });
    await mkdir(join(root, "secrets"));
    await mkdir(join(root, "assets"));
    await writeFile(secret, "server-private");
    await writeFile(readOnly, "published");
    await writeFile(outsideFile, "outside-private");
    // A broad parent grant still cannot expose server-private files or modify assets.
    const roots = [{ path: root, directory: true, write: true }];
    const probe = await buildSandboxCommand("/bin/echo", ["ready"], roots, workspace, root);
    if (!probe) return context.skip("Platform isolation is unavailable");
    try {
      await execute(probe.command, probe.args, {
        cwd: workspace,
        env: cleanEnvironment(workspace),
      });
    } catch (error) {
      if (
        process.platform === "linux" &&
        /operation not permitted|permission denied/i.test(String(error))
      )
        return context.skip("Host disables bubblewrap user namespaces");
      throw error;
    }
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const paths = JSON.stringify({ secret, readOnly, outsideFile, ownFile });
    const program = `
      import {lookup} from 'node:dns/promises';
      import {get} from 'node:http';
      import {readFile,writeFile} from 'node:fs/promises';
      const paths=${paths};
      const resolved=await lookup('localhost',{family:4});
      const body=await new Promise((resolve,reject)=>{
        get({hostname:'localhost',family:4,port:${port},path:'/package-index'},response=>{
          let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve(body));
        }).on('error',reject);
      });
      const blocked=async operation=>{try{await operation();return false;}catch{return true;}};
      await writeFile(paths.ownFile,body);
      console.log(JSON.stringify({
        resolved:resolved.address,body,
        secretBlocked:await blocked(()=>readFile(paths.secret)),
        outsideBlocked:await blocked(()=>readFile(paths.outsideFile)),
        assetWriteBlocked:await blocked(()=>writeFile(paths.readOnly,'changed')),
        asset:await readFile(paths.readOnly,'utf8')
      }));
    `;
    const spec = await buildSandboxCommand(
      process.execPath,
      ["--input-type=module", "-e", program],
      roots,
      workspace,
      root,
    );
    const result = await execute(spec!.command, spec!.args, {
      cwd: workspace,
      env: cleanEnvironment(workspace),
      timeout: 10000,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      resolved: "127.0.0.1",
      body: marker,
      secretBlocked: true,
      outsideBlocked: true,
      assetWriteBlocked: true,
      asset: "published",
    });
    expect(await readFile(ownFile, "utf8")).toBe(marker);
    expect(await readFile(secret, "utf8")).toBe("server-private");
    expect(await readFile(outsideFile, "utf8")).toBe("outside-private");
    expect(await readFile(readOnly, "utf8")).toBe("published");
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
