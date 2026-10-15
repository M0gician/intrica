import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// These entry points can spend provider credits only after explicit opt-in.
for (const runner of ["live", "autonomous"]) {
  test(`${runner} defaults to a dry plan without loading credentials`, () => {
    const result = spawnSync(
      process.execPath,
      [`scripts/context-experiments/${runner}.mjs`, "--config-file", "/definitely/not/a/config"],
      {
        cwd: new URL("../../", import.meta.url),
        encoding: "utf8",
        env: { ...process.env, MODEL_API_KEY: "must-never-appear" },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).mode, "dry-run");
    assert.ok(!result.stdout.includes("must-never-appear"));
  });
}
