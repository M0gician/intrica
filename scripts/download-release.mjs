import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { downloadAsset, readRelease, selectAsset } from "@intrica/releases";

const [version, suffix, directory] = process.argv.slice(2);
if (!directory) throw new Error("Usage: download-release.mjs VERSION PLATFORM-SUFFIX DIRECTORY");
const release = await readRelease(version);
const asset = selectAsset(release, suffix);
const root = resolve(directory);
await mkdir(root, { recursive: true });
const path = join(root, asset.name);
await downloadAsset(release.version, asset, path);
console.log(path);
