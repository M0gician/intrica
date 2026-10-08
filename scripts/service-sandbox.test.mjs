import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { prepareJourney, verifyJourney } from "../tests/fixtures/agent-journey.mjs";

test("native service honors persisted sandbox mode across startup, tool execution and restart", {
  timeout: 90_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "intrica-service-sandbox-"));
  const repository = resolve(import.meta.dirname, "..");
  const server = join(repository, "apps/server");
  for (const name of ["service.mjs", "runtime.mjs", "package.json"])
    await cp(join(server, name), join(root, name));
  for (const name of ["dist", "node_modules"]) await symlink(join(server, name), join(root, name));
  await symlink(join(repository, "db"), join(root, "db"));
  await symlink(join(repository, "apps/web/dist"), join(root, "web"));
  const { version } = JSON.parse(await readFile(join(server, "package.json"), "utf8"));
  await writeFile(
    join(root, "release.json"),
    JSON.stringify({ version, commit: "service-sandbox-test" }),
  );
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const configPath = join(root, "server.json");
  const config = {
    host: "127.0.0.1",
    port,
    accessToken: randomUUID(),
    databasePassword: randomUUID(),
    stateDir: join(root, "state"),
    sandbox: "required",
  };
  const sandboxModule = pathToFileURL(join(server, "dist/adapters/host/sandbox.js")).href;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const {isolationAvailable}=await import(${JSON.stringify(sandboxModule)}); console.log(JSON.stringify(await isolationAvailable()));`,
    ],
    { env: { ...process.env, INTRICA_SANDBOX: "required" } },
  );
  const available = JSON.parse(stdout);
  let child, exited, journey;
  let output = "";
  const call = async (path, method = "GET", body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/v2/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.ok, true, `${path}: ${response.status}`);
    return response.json();
  };
  const launch = async () => {
    output = "";
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    child = spawn(process.execPath, [join(root, "service.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        MODEL_KIND: "mock",
        INTRICA_SERVICE_CONFIG: configPath,
        INTRICA_WORKSPACE_DIR: root,
        INTRICA_SANDBOX: config.sandbox === "required" ? "disabled" : "required",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    exited = once(child, "exit");
    child.stdout.on("data", (data) => {
      output = (output + data).slice(-16000);
    });
    child.stderr.on("data", (data) => {
      output = (output + data).slice(-16000);
    });
  };
  const ready = async () => {
    for (let i = 0; i < 300; i++) {
      assert.equal(child.exitCode, null, output);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/v2/ready`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) return;
      } catch {}
      await delay(100);
    }
    assert.fail(`Service did not become ready: ${output}`);
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    const [code, signal] = await exited;
    clearTimeout(timer);
    assert.equal(signal, null, output);
    assert.equal(code, 0, output);
  };
  try {
    await launch();
    if (available) {
      await ready();
      const diagnostics = await call("settings/diagnostics");
      assert.equal(diagnostics.isolation, available);
      assert.equal(diagnostics.sandboxStatus, "enabled");
      journey = await prepareJourney(call);
      await journey.start();
      await verifyJourney(call, journey);
      await journey.close();
      journey = undefined;
      await stop();
    } else {
      const [code] = await exited;
      assert.notEqual(code, 0);
      assert.match(output, /Configured sandbox is unavailable/);
      await assert.rejects(stat(config.stateDir), { code: "ENOENT" });
    }
    config.sandbox = "disabled";
    await launch();
    await ready();
    assert.equal((await call("settings/diagnostics")).isolation, null);
    assert.equal((await call("settings/diagnostics")).sandboxStatus, "disabled");
    journey = await prepareJourney(call);
    await journey.start();
    await verifyJourney(call, journey);
    const canvasId = journey.board.id;
    await journey.close();
    journey = undefined;
    await stop();
    await launch();
    await ready();
    assert.equal((await call("settings/diagnostics")).isolation, null);
    assert.equal((await call("settings/diagnostics")).sandboxStatus, "disabled");
    assert.ok((await call("bootstrap")).nodes.some((node) => node.id === canvasId));
    await stop();
    config.sandbox = "invalid";
    await launch();
    assert.notEqual((await exited)[0], 0);
    assert.match(output, /Invalid server configuration/);
  } finally {
    try {
      await journey?.close();
    } finally {
      await stop();
      await rm(root, { recursive: true, force: true });
    }
  }
});
