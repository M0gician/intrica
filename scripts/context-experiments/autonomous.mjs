import { spawn } from "node:child_process";
import { once } from "node:events";

const args = process.argv.slice(2);
const option = (key) => (args.includes(key) ? args[args.indexOf(key) + 1] : undefined);
if (!args.includes("--live")) {
  process.stdout.write(
    `${JSON.stringify({ mode: "dry-run", experiment: "model-led-context-recovery", maxRequests: 6, maxOutputTokens: 2000, note: "No credentials read or network used. Opt in with --live --config-file PATH [--out PATH]. Uses an isolated temporary database and the production read_context tool. Build the workspace first." }, null, 2)}\n`,
  );
} else {
  const config = option("--config-file");
  if (!config) throw new Error("--live requires an explicit --config-file path");
  const child = spawn(
    process.execPath,
    [
      "scripts/ci-tests.mjs",
      "integration",
      "context-autonomous-live.test.ts",
      "--reporter=verbose",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        INTRICA_CONTEXT_LIVE: "1",
        INTRICA_CONTEXT_LIVE_CONFIG: config,
        INTRICA_CONTEXT_LIVE_OUT: option("--out") ?? "/tmp/intrica-context-autonomous.json",
      },
    },
  );
  const [code] = await once(child, "exit");
  process.exitCode = code ?? 1;
}
