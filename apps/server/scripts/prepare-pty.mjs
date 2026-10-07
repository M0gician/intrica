import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// node-pty 1.1.0 ships its macOS prebuilt spawn-helper without the executable bit.
if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("node-pty/package.json"));
  for (const path of [
    join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    join(root, "build", "Release", "spawn-helper"),
  ]) {
    if (existsSync(path)) chmodSync(path, 0o755);
  }
}
