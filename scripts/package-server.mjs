import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("Build the native server on Linux x64.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? join(root, "release-server"));
const { version } = JSON.parse(await readFile(join(root, "apps/server/package.json"), "utf8"));
const temporary = await mkdtemp(join(tmpdir(), "intrica-package-"));
const bundle = join(temporary, "server");
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });
try {
  run("pnpm", ["--filter", "@intrica/server...", "--filter", "@intrica/web...", "build"]);
  // Materialize workspace dependencies only for deployment; development keeps
  // ordinary workspace links. Legacy deploy can leave links to the CI checkout.
  run("pnpm", [
    "--filter",
    "@intrica/server",
    "deploy",
    "--prod",
    "--config.inject-workspace-packages=true",
    bundle,
  ]);
  await mkdir(join(bundle, "bin"));
  await cp(process.execPath, join(bundle, "bin/node"));
  await cp(join(dirname(process.execPath), "../LICENSE"), join(bundle, "NODE-LICENSE"));
  await cp(join(root, "LICENSE"), join(bundle, "LICENSE"));
  await cp(join(root, "db"), join(bundle, "db"), { recursive: true });
  await cp(join(root, "apps/web/dist"), join(bundle, "web"), { recursive: true });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  await writeFile(
    join(bundle, "release.json"),
    `${JSON.stringify({ version, commit, node: process.version })}\n`,
  );
  await writeFile(
    join(bundle, "bin/intrica-server"),
    `#!/usr/bin/env bash
set -euo pipefail
directory=$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")/.." && pwd -P)
exec "$directory/bin/node" "$directory/service.mjs"
`,
    { mode: 0o755 },
  );
  await mkdir(output, { recursive: true });
  run("tar", [
    "-czf",
    join(output, `Intrica-${version}-server-linux-x64.tar.gz`),
    "-C",
    bundle,
    ".",
  ]);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
