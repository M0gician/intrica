import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
let cached: { expires: number; value: Promise<NodeJS.ProcessEnv> } | undefined;
export const userShell = () =>
  process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");

/** One login environment for terminals, execution tools and MCP. Never log its values. */
export function shellEnvironment(): Promise<NodeJS.ProcessEnv> {
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = (async () => {
    if (process.platform === "win32") return { ...process.env };
    const marker = `INTRICA_ENV_${crypto.randomUUID()}`;
    try {
      const { stdout } = await execute(
        userShell(),
        ["-ilc", `printf '${marker}\\0'; /usr/bin/env -0`],
        {
          timeout: 5000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env },
        },
      );
      const start = stdout.indexOf(`${marker}\0`);
      if (start < 0) throw new Error("Login shell did not return its environment");
      const entries = stdout
        .slice(start + marker.length + 1)
        .split("\0")
        .flatMap((entry) => {
          const equal = entry.indexOf("=");
          return equal > 0 ? [[entry.slice(0, equal), entry.slice(equal + 1)]] : [];
        });
      return { ...process.env, ...Object.fromEntries(entries) };
    } catch {
      // A broken shell startup must not prevent opening a terminal to repair it.
      return { ...process.env };
    }
  })();
  cached = { expires: Date.now() + 5000, value };
  return value;
}
