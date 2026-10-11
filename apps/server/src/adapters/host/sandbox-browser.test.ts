import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { buildSandboxCommand, cleanEnvironment } from "./sandbox.js";

test("a real isolated browser renders WebGL, handles input, saves a screenshot and cannot read private files", async (context) => {
  const repository = fileURLToPath(new URL("../../../../../", import.meta.url));
  const require = createRequire(join(repository, "tests/e2e/package.json"));
  const module = require.resolve("playwright");
  const { chromium } = await import(module);
  const executable = chromium.executablePath();
  try {
    await readFile(executable);
  } catch {
    return context.skip("Playwright Chromium is not installed");
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "intrica-browser-")));
  const workspace = join(root, "workspace");
  const secret = join(root, "secrets", "private.txt");
  const unrelated = join(root, "unrelated.txt");
  const html =
    '<button id="change">Change color</button><canvas id="scene" width="96" height="64"></canvas><script>const gl=scene.getContext("webgl",{preserveDrawingBuffer:true});function draw(){gl.clearColor(1,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);}draw();change.onclick=()=>{gl.clearColor(0,1,0,1);gl.clear(gl.COLOR_BUFFER_BIT);};</script>';
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(html);
  });
  try {
    await mkdir(join(workspace, ".tmp"), { recursive: true });
    await mkdir(join(root, "secrets"));
    await writeFile(secret, "server-secret");
    await writeFile(unrelated, "outside-grants");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://localhost:${(server.address() as AddressInfo).port}`;
    const png = join(workspace, "render.png");
    const script = `
      import playwright from ${JSON.stringify(module)};
      const {chromium}=playwright;
      import {readFile} from 'node:fs/promises';
      import {pathToFileURL} from 'node:url';
      const browser=await chromium.launch({executablePath:${JSON.stringify(executable)},headless:true,args:['--enable-unsafe-swiftshader']});
      try {
        const page=await browser.newPage({viewport:{width:480,height:320}});
        await page.goto(${JSON.stringify(url)});
        await page.locator('#change').click();
        const pixel=await page.evaluate(()=>{const gl=document.querySelector('canvas').getContext('webgl');const out=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,out);return [...out];});
        await page.screenshot({path:${JSON.stringify(png)}});
        let browserPrivateBlocked=false;
        try {await page.goto(pathToFileURL(${JSON.stringify(secret)}).href);browserPrivateBlocked=!(await page.content()).includes('server-secret');}catch{browserPrivateBlocked=true;}
        const blocked=async(path)=>{try{await readFile(path);return false;}catch{return true;}};
        console.log(JSON.stringify({pixel,browserPrivateBlocked,secretBlocked:await blocked(${JSON.stringify(secret)}),outsideBlocked:await blocked(${JSON.stringify(unrelated)})}));
      }finally{await browser.close();}
    `;
    const spec = await buildSandboxCommand(
      process.execPath,
      ["--input-type=module", "-e", script],
      [
        { path: workspace, directory: true, write: true },
        { path: join(repository, "node_modules"), directory: true, write: false },
        { path: join(repository, "tests/e2e/node_modules"), directory: true, write: false },
      ],
      workspace,
      root,
    );
    if (!spec) return context.skip("Platform isolation is unavailable");
    const result = await promisify(execFile)(spec.command, spec.args, {
      cwd: workspace,
      env: cleanEnvironment(workspace),
      timeout: 30_000,
      maxBuffer: 128_000,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      pixel: [0, 255, 0, 255],
      browserPrivateBlocked: true,
      secretBlocked: true,
      outsideBlocked: true,
    });
    expect((await readFile(png)).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
