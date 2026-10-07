// Each invocation owns its database, ports and subprocesses, including on developer runners.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const mode = process.argv[2];
if (!["functional", "browser", "integration"].includes(mode))
  throw new Error("Expected functional, browser or integration");
const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
const entry = require.resolve("embedded-postgres");
const { default: EmbeddedPostgres } = await import(pathToFileURL(entry).href);
const exitHook = createRequire(entry)("async-exit-hook");
for (const event of exitHook.hookedEvents()) exitHook.unhookEvent(event);
const probes = await Promise.all(
  [0, 1, 2].map(async () => {
    const socket = createServer().listen(0, "127.0.0.1");
    await once(socket, "listening");
    return socket;
  }),
);
const [databasePort, apiPort, uiPort] = probes.map((p) => p.address().port);
await Promise.all(probes.map((p) => new Promise((resolve) => p.close(resolve))));
const directory = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "intrica-ci-"));
const password = randomUUID();
if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${password}`);
const postgres = new EmbeddedPostgres({
  databaseDir: join(directory, "postgres"),
  port: databasePort,
  user: "intrica_ci",
  password,
  persistent: true,
  postgresFlags: ["-h", "127.0.0.1", "-k", ""],
  onLog() {},
  onError: (error) => console.error("[ci:postgres]", error),
});
let child;
let cancelled = false;
const cancel = () => {
  cancelled = true;
  if (child?.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
};
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  await postgres.initialise();
  await postgres.start();
  if (cancelled) process.exitCode = 130;
  else {
    const args =
      mode === "functional"
        ? [
            "-r",
            "--workspace-concurrency=1",
            "--filter=!@intrica/tests-e2e",
            "--filter=!@intrica/desktop",
            "test",
          ]
        : mode === "integration"
          ? [
              "--filter",
              "@intrica/tests-integration",
              "exec",
              "vitest",
              "run",
              ...process.argv.slice(3),
            ]
          : ["--filter", "@intrica/tests-e2e", "test", ...process.argv.slice(3)];
    child = spawn("pnpm", args, {
      cwd: root,
      detached: true,
      stdio: "inherit",
      env: {
        ...process.env,
        TMPDIR: directory,
        INTRICA_TEST_ADMIN_URL: `postgres://intrica_ci:${password}@127.0.0.1:${databasePort}/postgres`,
        INTRICA_E2E_API_PORT: String(apiPort),
        INTRICA_E2E_UI_PORT: String(uiPort),
        INTRICA_E2E_SKIP_BUILD: "1",
        INTRICA_E2E_PREVIEW: "1",
      },
    });
    const [code] = await once(child, "exit");
    process.exitCode = code ?? 1;
  }
} finally {
  try {
    await postgres.stop();
    await rm(directory, { recursive: true, force: true });
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
