import { type ChildProcess, spawn } from "node:child_process";

// A small process supervisor survives Worker failure long enough to kill its
// command group. It receives only the tool's clean environment, never credentials.
let child: ChildProcess | undefined;
let stopping = false;
const parent = process.ppid;
function stop() {
  if (stopping) return;
  stopping = true;
  if (child?.pid)
    try {
      process.platform === "win32" ? child.kill("SIGKILL") : process.kill(-child.pid, "SIGKILL");
    } catch {}
  process.exit(0);
}
function launch(input: { command: string; args: string[]; cwd?: string }) {
  child = spawn(input.command, input.args, {
    cwd: input.cwd ?? process.cwd(),
    env: process.env,
    detached: process.platform !== "win32",
    stdio: "inherit",
  });
  child.once("error", (error) => {
    if (process.send) process.send({ error: error.message }, () => process.exit(1));
    else process.exit(1);
  });
  child.once("exit", (exitCode, signal) => {
    if (child?.pid && process.platform !== "win32")
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    if (process.send) process.send({ exitCode, signal }, () => process.exit(exitCode ?? 1));
    else process.exit(exitCode ?? 1);
  });
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
process.once("disconnect", stop);
setInterval(() => {
  if (process.ppid !== parent) stop();
}, 100).unref();
if (process.send) process.once("message", (message: any) => launch(message));
else launch(JSON.parse(process.argv[2]!));
