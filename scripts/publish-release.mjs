import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseManifest, readRelease } from "@intrica/releases";

const [directory, tag, notes] = process.argv.slice(2);
assert.equal(process.env.GITHUB_ACTIONS, "true", "Publish from the release workflow");
assert.ok(process.env.GH_TOKEN, "The workflow job token is required");
const manifest = parseManifest(JSON.parse(await readFile(join(directory, "intrica-update.json"))));
assert.equal(tag, `v${manifest.version}`);
const names = [...manifest.assets.map((a) => a.name), "intrica-update.json", "SHA256SUMS"];
const expected = [];
for (const name of names) {
  const path = join(directory, name);
  const stat = await lstat(path);
  assert.ok(stat.isFile());
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const sha256 = hash.digest("hex");
  const declared = manifest.assets.find((asset) => asset.name === name);
  if (declared) {
    assert.equal(stat.size, declared.size);
    assert.equal(sha256, declared.sha256);
  }
  expected.push({ name, size: stat.size, digest: `sha256:${sha256}` });
}
execFileSync(
  "gh",
  [
    "release",
    "create",
    tag,
    ...names.map((name) => join(directory, name)),
    "--draft",
    "--verify-tag",
    "--title",
    `Intrica ${tag}`,
    "--notes-file",
    notes,
  ],
  { stdio: "inherit" },
);
const release = JSON.parse(
  execFileSync("gh", ["release", "view", tag, "--json", "isDraft,assets"], { encoding: "utf8" }),
);
assert.equal(release.isDraft, true);
assert.equal(release.assets.length, expected.length);
for (const asset of expected) {
  const found = release.assets.filter((a) => a.name === asset.name);
  assert.equal(found.length, 1);
  assert.equal(found[0].size, asset.size);
  assert.equal(found[0].digest, asset.digest);
}
execFileSync("gh", ["release", "edit", tag, "--draft=false", "--latest"], { stdio: "inherit" });
const published = await readRelease(manifest.version);
assert.deepEqual(published.assets, manifest.assets);
