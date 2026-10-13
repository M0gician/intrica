import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prerequisiteScript, runCommand } from "./deploy-server.mjs";

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
async function fixture(
  t,
  { uid = "10765", linger = "no", allowed = true, query = true, manager = true } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "intrica-prerequisites-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, "linger");
  const log = join(directory, "calls");
  const program = (name, text) =>
    writeFile(join(directory, name), `#!/bin/bash\nset -eu\n${text}\n`, { mode: 0o700 });
  await program("uname", 'if test "$1" = -s; then echo Linux; else echo x86_64; fi');
  await program("id", `if test "$1" = -u; then echo ${uid}; else echo fixture-account; fi`);
  await program("systemctl", `exit ${manager ? 0 : 1}`);
  await program("flock", "exit 0");
  await program("sha256sum", "exit 0");
  await program(
    "loginctl",
    `
printf '%s\\n' "$*" >> ${quote(log)}
if test "$1" = --no-ask-password; then
  test "$2" = enable-linger && test "$3" = ${quote(uid)}
  ${allowed ? `touch ${quote(marker)}` : "exit 1"}
else
  test "$1" = show-user && test "$2" = ${quote(uid)}
  ${query ? `if test -f ${quote(marker)}; then echo yes; else echo ${quote(linger)}; fi` : "echo 'query failed' >&2; exit 1"}
fi`,
  );
  return {
    run: (mode) =>
      runCommand("bash", ["-s"], {
        input: `set -eu\n${prerequisiteScript}\nintrica_prerequisites ${mode}\n`,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
      }),
    calls: () => readFile(log, "utf8"),
  };
}

test("inspection reports disabled linger without changing it", async (t) => {
  const f = await fixture(t);
  const result = await f.run("inspect");
  assert.match(result, /linger=no\n/);
  assert.doesNotMatch(await f.calls(), /enable-linger/);
});

test("preparation enables only the actual account without an interactive prompt", async (t) => {
  for (const uid of ["1001", "22007"]) {
    const f = await fixture(t, { uid });
    assert.match(await f.run("prepare"), /linger=yes\n/);
    assert.match(await f.calls(), new RegExp(`--no-ask-password enable-linger ${uid}`));
    await f.run("prepare");
    assert.equal((await f.calls()).match(/enable-linger/g).length, 1);
  }
});

test("query errors, policy denial and missing user managers remain distinct", async (t) => {
  for (const [configuration, code] of [
    [{ query: false }, "LINGER_QUERY_FAILED"],
    [{ allowed: false }, "LINGER_PERMISSION_REQUIRED"],
    [{ linger: "yes", manager: false }, "USER_MANAGER_UNAVAILABLE"],
  ]) {
    const f = await fixture(t, configuration);
    await assert.rejects(f.run("prepare"), (error) => {
      assert.equal(error.code, code);
      if (code === "LINGER_PERMISSION_REQUIRED")
        assert.equal(error.remediation, "loginctl enable-linger 10765");
      return true;
    });
    if (code === "LINGER_QUERY_FAILED") assert.doesNotMatch(await f.calls(), /enable-linger/);
  }
});
