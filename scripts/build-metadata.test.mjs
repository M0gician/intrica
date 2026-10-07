import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("all package builders retain full preview stamps and explicit build times using the same collector", async () => {
  const directory = await mkdtemp(join(tmpdir(), "intrica-build-info-"));
  try {
    await writeFile(join(directory, "package.json"), JSON.stringify({ version: "0.2.5" }));
    const stamp = "0123456789ab+preview.abcdef012345";
    const output = join(directory, "build.json");
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("./build-metadata.mjs", import.meta.url)), output],
      {
        cwd: directory,
        env: {
          ...process.env,
          INTRICA_COMMIT: stamp,
          INTRICA_BUILD_TIME: "2026-09-22T00:00:00Z",
          INTRICA_CHANNEL: "preview",
          MODEL_API_KEY: "test-not-for-output",
        },
      },
    );
    const value = JSON.parse(await readFile(output, "utf8"));
    assert.equal(value.buildId, stamp);
    assert.equal(value.commit, stamp);
    assert.equal(value.version, "0.2.5");
    assert.equal(value.builtAt, "2026-09-22T00:00:00Z");
    assert.equal(value.channel, "preview");
    assert.equal(JSON.stringify(value).includes("test-not-for-output"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
