import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import {
  browserRuntimes,
  buildSandboxCommand,
  cleanEnvironment,
  prepareRuntime,
} from "./sandbox.js";

const execute = promisify(execFile);
test("scoped Chromium loads network HTML, executes scripts and renders WebGL with a private profile", async (context) => {
  const roots = await browserRuntimes();
  const executables = [...roots]
    .sort(
      (a, b) =>
        Number(b.includes("headless_shell")) - Number(a.includes("headless_shell")) ||
        b.localeCompare(a),
    )
    .flatMap((root) => [
      join(root, "MacOS/Google Chrome"),
      join(root, "MacOS/Chromium"),
      join(root, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
      join(root, "Chromium.app/Contents/MacOS/Chromium"),
      join(root, "chrome-headless-shell"),
      join(root, "chrome"),
    ]);
  let browser: string | undefined;
  for (const candidate of executables)
    if (
      await access(candidate).then(
        () => true,
        () => false,
      )
    ) {
      browser = candidate;
      break;
    }
  if (!browser) return context.skip("No Chromium distribution installed");
  const root = await realpath(await mkdtemp(join(tmpdir(), "intrica-browser-")));
  const home = join(root, "workspace");
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<canvas id="c"></canvas><script>const gl=document.getElementById("c").getContext("webgl2");if(gl){gl.clearColor(0,1,0,1);gl.clear(gl.COLOR_BUFFER_BIT);const p=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);document.body.dataset.webgl=p[1]===255?"rendered":"failed";}document.body.dataset.script="executed";</script>',
    );
  });
  try {
    await mkdir(join(home, ".tmp"), { recursive: true });
    await prepareRuntime(home);
    await mkdir(join(root, "secrets"));
    await writeFile(join(root, "secrets", "private"), "server-private");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const spec = await buildSandboxCommand(
      browser,
      [
        "--headless",
        "--no-sandbox",
        "--disable-gpu-sandbox",
        "--disable-gpu",
        "--enable-unsafe-swiftshader",
        "--use-angle=swiftshader",
        `--user-data-dir=${join(home, "profile")}`,
        "--dump-dom",
        `http://127.0.0.1:${port}`,
      ],
      [{ path: home, directory: true, write: true }],
      home,
      root,
    );
    if (!spec) return context.skip("Platform isolation unavailable");
    const result = await execute(spec.command, spec.args, {
      cwd: home,
      env: cleanEnvironment(home),
      timeout: 20000,
      maxBuffer: 1024 * 1024,
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
    if (!result) return;
    expect(result.stdout).toContain('data-script="executed"');
    expect(result.stdout).toContain('data-webgl="rendered"');
    const runtime = await buildSandboxCommand(
      "/bin/bash",
      ["-c", 'node -e "console.log(process.versions.node)"'],
      [{ path: home, directory: true, write: true }],
      home,
      root,
    );
    const node = await execute(runtime!.command, runtime!.args, {
      cwd: home,
      env: cleanEnvironment(home),
      timeout: 5000,
    });
    expect(node.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
