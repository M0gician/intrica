import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseManifest, releaseNames } from "@intrica/releases";

const [output, tag, image] = process.argv.slice(2);
const desktop = JSON.parse(
  await readFile(new URL("../apps/desktop/package.json", import.meta.url)),
);
const server = JSON.parse(await readFile(new URL("../apps/server/package.json", import.meta.url)));
if (!output || tag !== `v${desktop.version}` || server.version !== desktop.version)
  throw new Error("Release versions must match");
const directory = dirname(output);
const assets = [];
for (const name of releaseNames(desktop.version)) {
  const path = join(directory, name);
  const stat = await lstat(path);
  if (!stat.isFile()) throw new Error(`Not a regular release file: ${name}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  assets.push({ name, size: stat.size, sha256: hash.digest("hex") });
}
const native = JSON.parse(
  execFileSync(
    "tar",
    [
      "-xOzf",
      join(directory, `Intrica-${server.version}-server-linux-x64.tar.gz`),
      "./release.json",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 },
  ),
);
if (native.version !== server.version || !Array.isArray(native.sandboxModes))
  throw new Error("Native server package must declare its version and sandbox modes");
const manifest = parseManifest({
  format: 2,
  version: desktop.version,
  publishedAt: new Date().toISOString(),
  apiVersion: "v2",
  schemaVersion: Number(
    (await readFile(new URL("../db/schema.sql", import.meta.url), "utf8")).match(
      /INSERT INTO schema_info\(version\) VALUES \((\d+)\)/,
    )[1],
  ),
  serverImage: image,
  serverSandboxModes: native.sandboxModes,
  assets,
});
const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(output, bytes);
const hashes = [
  ...assets,
  { name: "intrica-update.json", sha256: createHash("sha256").update(bytes).digest("hex") },
];
await writeFile(
  join(directory, "SHA256SUMS"),
  hashes.map((a) => `${a.sha256}  ./${a.name}\n`).join(""),
);
