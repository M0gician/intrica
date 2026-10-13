// Download a previous release, verify its bytes, and print its unpacked executable.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { downloadAsset, readRelease, selectAsset } from "@intrica/releases";

const [version, directory] = process.argv.slice(2);
assert.match(version, /^\d+\.\d+\.\d+$/);
assert.ok(directory && ["darwin", "linux"].includes(process.platform));
const root = resolve(directory);
await mkdir(root, { recursive: true });
const mac = process.platform === "darwin";
const asset = `Intrica-${version}-${mac ? "mac-arm64.dmg" : "linux-x86_64.AppImage"}`;
const release = await readRelease(version);
await downloadAsset(
  version,
  selectAsset(release, mac ? "mac-arm64.dmg" : "linux-x86_64.AppImage"),
  join(root, asset),
);
let executable;
if (mac) {
  const volume = join(root, "volume");
  await mkdir(volume, { recursive: true });
  execFileSync(
    "hdiutil",
    ["attach", join(root, asset), "-readonly", "-nobrowse", "-mountpoint", volume],
    { stdio: "pipe" },
  );
  try {
    execFileSync("ditto", [join(volume, "Intrica.app"), join(root, "Intrica.app")]);
  } finally {
    execFileSync("hdiutil", ["detach", volume], { stdio: "pipe" });
  }
  executable = join(root, "Intrica.app/Contents/MacOS/Intrica");
} else {
  executable = join(root, asset);
  await chmod(executable, 0o755);
}
console.log(executable);
