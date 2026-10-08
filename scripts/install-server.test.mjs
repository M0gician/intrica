import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const installer = new URL("./install-server.sh", import.meta.url).pathname;

async function fixture(
  t,
  {
    existing = false,
    health = true,
    linger = true,
    platform = "Linux",
    lock = true,
    sandbox = true,
    sandboxModes = ["required", "disabled"],
    installedSandbox = "required",
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "intrica-installer-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fakeHome = join(directory, "user");
  const commands = join(directory, "commands");
  const packageRoot = join(directory, "package");
  const base = join(fakeHome, ".local/share/intrica-server");
  const config = join(fakeHome, ".config/intrica/server.json");
  const unit = join(fakeHome, ".config/systemd/user/intrica-server.service");
  await Promise.all([
    mkdir(commands),
    mkdir(join(packageRoot, "bin"), { recursive: true }),
    mkdir(join(fakeHome, ".config/intrica"), { recursive: true }),
    mkdir(join(fakeHome, ".config/systemd/user"), { recursive: true }),
    mkdir(base, { recursive: true }),
  ]);
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const program = async (name, content) =>
    writeFile(join(commands, name), `#!/bin/bash\nset -eu\n${content}\n`, { mode: 0o755 });
  await program("uname", `if [[ "$1" == -s ]]; then echo ${quote(platform)}; else echo x86_64; fi`);
  await program("id", 'if [[ "$1" == -u ]]; then echo 1000; else echo fixture-user; fi');
  await program("loginctl", `echo ${linger ? "yes" : "no"}`);
  await program("bwrap", `exit ${sandbox ? 0 : 1}`);
  await program("flock", `exit ${lock ? 0 : 1}`);
  await program(
    "systemctl",
    `printf '%s\\n' "$*" >> ${quote(join(directory, "systemctl.log"))}
if [[ "$*" == '--user cat intrica-server.service' ]]; then test -f ${quote(unit)}; fi`,
  );
  await program(
    "sha256sum",
    `${quote(process.execPath)} --input-type=module -e 'import {createHash} from "node:crypto"; import {readFileSync} from "node:fs"; const s=readFileSync(0,"utf8").trim();const i=s.indexOf("  ");process.exit(createHash("sha256").update(readFileSync(s.slice(i+2))).digest("hex")===s.slice(0,i)?0:1);'`,
  );
  // GNU mv -T is not available on the macOS test host; emulate exactly the
  // atomic rename used by the Linux installer, never the actual user's paths.
  await program(
    "mv",
    `if [[ "$1" == -Tf ]]; then ${quote(process.execPath)} --input-type=module -e 'import {renameSync} from "node:fs";renameSync(process.argv[1],process.argv[2])' "$2" "$3"; else /bin/mv "$@"; fi`,
  );
  await writeFile(
    join(packageRoot, "bin/node"),
    `#!/bin/bash
set -eu
if [[ "$#" == 4 && "$3" == */server.json && "$4" == */release.json ]]; then
  /bin/cat >/dev/null
  exit ${health ? 0 : 1}
fi
exec ${quote(process.execPath)} "$@"
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(packageRoot, "release.json"),
    JSON.stringify({ version: "0.2.6", commit: "fixture", sandboxModes }),
  );
  const archive = join(directory, "server.tar.gz");
  await exec("tar", ["-czf", archive, "-C", packageRoot, "."]);
  const buffer = await readFile(archive);
  const digest = createHash("sha256").update(buffer).digest("hex");
  const oldConfig = {
    host: "0.0.0.0",
    port: 4567,
    accessToken: "secret-token-never-log",
    databasePassword: "secret-database-never-log",
    stateDir: join(fakeHome, "custom-state"),
    extraSetting: "preserved",
    sandbox: installedSandbox,
  };
  const oldTarget = join(base, "releases/v0.2.5-previous");
  // The production runtime requires this absolute executable. Only this path
  // is redirected for isolated control-flow tests; no real namespaces/daemon run.
  const testInstaller = join(directory, "install-server.sh");
  await writeFile(
    testInstaller,
    (await readFile(installer, "utf8")).replaceAll("/usr/bin/bwrap", join(commands, "bwrap")),
  );
  if (existing) {
    await mkdir(oldTarget, { recursive: true });
    await writeFile(join(oldTarget, "release.json"), JSON.stringify({ version: "0.2.5" }));
    await symlink(oldTarget, join(base, "current"));
    await writeFile(config, JSON.stringify(oldConfig), { mode: 0o600 });
    await writeFile(unit, "old-service-definition\n");
    await mkdir(oldConfig.stateDir);
    await writeFile(join(oldConfig.stateDir, "must-survive"), "database fixture");
  }
  return {
    base,
    config,
    unit,
    oldConfig,
    oldTarget,
    directory,
    async run({ sha = digest, size = buffer.length, extra = [] } = {}) {
      try {
        const result = await exec(
          "bash",
          [
            testInstaller,
            "v0.2.6",
            "--archive",
            archive,
            "--sha256",
            sha,
            "--size",
            String(size),
            ...extra,
          ],
          {
            env: { ...process.env, HOME: fakeHome, PATH: `${commands}:${process.env.PATH}` },
            timeout: 10_000,
          },
        );
        return { ...result, code: 0 };
      } catch (error) {
        if (typeof error.code !== "number") throw error;
        return { stdout: error.stdout, stderr: error.stderr, code: error.code };
      }
    },
    async serviceLog() {
      return readFile(join(directory, "systemctl.log"), "utf8").catch(() => "");
    },
  };
}

test("fresh verified install is loopback/private, has recovery marker, never prints credentials", async (t) => {
  const item = await fixture(t);
  const result = await item.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Intrica Server is ready/, JSON.stringify(result));
  const config = JSON.parse(await readFile(item.config, "utf8"));
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3001);
  assert.equal(config.sandbox, "required");
  assert.ok(config.accessToken.length >= 32);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(config.accessToken));
  assert.equal((await stat(item.config)).mode & 0o777, 0o600);
  assert.match(await item.serviceLog(), /enable --now intrica-server.service/);
  const [recovery] = await readdir(join(item.base, "recovery"));
  assert.equal(await readFile(join(item.base, "recovery", recovery, "phase"), "utf8"), "healthy\n");
});

test("update preserves credentials, custom state/settings and saves previous service/config/target", async (t) => {
  const item = await fixture(t, { existing: true });
  const result = await item.run({ extra: ["--port", "4568"] });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(item.config, "utf8")), {
    ...item.oldConfig,
    port: 4568,
  });
  assert.equal(
    await readFile(join(item.oldConfig.stateDir, "must-survive"), "utf8"),
    "database fixture",
  );
  const [entry] = await readdir(join(item.base, "recovery"));
  const recovery = join(item.base, "recovery", entry);
  assert.deepEqual(
    JSON.parse(await readFile(join(recovery, "server.json"), "utf8")),
    item.oldConfig,
  );
  assert.equal(
    await readFile(join(recovery, "previous-release.txt"), "utf8"),
    `${item.oldTarget}\n`,
  );
  assert.equal(
    await readFile(join(recovery, "intrica-server.service"), "utf8"),
    "old-service-definition\n",
  );
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /secret-token-never-log|secret-database-never-log/,
  );
});

test("health failure stops candidate, retains data/recovery, and never starts old package blindly", async (t) => {
  const item = await fixture(t, { existing: true, health: false });
  const result = await item.run();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /recovery files:/);
  assert.match(result.stderr, /migration compatibility/);
  assert.equal(
    await readFile(join(item.oldConfig.stateDir, "must-survive"), "utf8"),
    "database fixture",
  );
  assert.match(await readlink(join(item.base, "current")), /v0.2.6-/);
  assert.equal(
    (await item.serviceLog()).trim().split("\n").at(-1),
    "--user stop intrica-server.service",
  );
  const [entry] = await readdir(join(item.base, "recovery"));
  assert.equal(await readFile(join(item.base, "recovery", entry, "phase"), "utf8"), "activating\n");
});

test("hash or size failure happens before stopping the running service or touching config", async (t) => {
  const item = await fixture(t, { existing: true });
  for (const mismatch of [{ sha: "0".repeat(64) }, { size: 1 }]) {
    const result = await item.run(mismatch);
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(await item.serviceLog(), /stop |enable /);
    assert.equal(await readlink(join(item.base, "current")), item.oldTarget);
    assert.deepEqual(JSON.parse(await readFile(item.config, "utf8")), item.oldConfig);
  }
});

test("installer rechecks current release under its lock and refuses stale-plan downgrades", async (t) => {
  const item = await fixture(t, { existing: true });
  // A newer deployment completed after the CLI's earlier preflight/download began.
  await writeFile(join(item.oldTarget, "release.json"), JSON.stringify({ version: "0.2.7" }));
  const result = await item.run();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Downgrades are refused/);
  assert.doesNotMatch(await item.serviceLog(), /stop |enable /);
  assert.equal(await readlink(join(item.base, "current")), item.oldTarget);
  assert.deepEqual(JSON.parse(await readFile(item.config, "utf8")), item.oldConfig);
});

test("installer fails closed for missing or malformed current release metadata", async (t) => {
  for (const contents of [null, "broken-json", JSON.stringify({ version: "unknown" })]) {
    const item = await fixture(t, { existing: true });
    const metadata = join(item.oldTarget, "release.json");
    if (contents === null) await rm(metadata);
    else await writeFile(metadata, contents);
    const result = await item.run();
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /manual recovery is required/);
    assert.doesNotMatch(await item.serviceLog(), /stop |enable /);
    assert.equal(await readlink(join(item.base, "current")), item.oldTarget);
  }
});

test("malformed private configuration fails without echoing its contents or stopping service", async (t) => {
  const item = await fixture(t, { existing: true });
  await writeFile(item.config, '{"accessToken":"must-never-appear-in-diagnostic", BROKEN');
  const result = await item.run();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Cannot read server configuration/);
  assert.doesNotMatch(result.stdout + result.stderr, /must-never-appear-in-diagnostic/);
  assert.doesNotMatch(await item.serviceLog(), /stop |enable /);
});

test("missing linger, unsupported OS and concurrent installer are blocked before service changes", async (t) => {
  for (const configuration of [
    { linger: false },
    { platform: "Darwin" },
    { lock: false },
    { sandbox: false },
  ]) {
    const item = await fixture(t, { existing: true, ...configuration });
    const result = await item.run();
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(await item.serviceLog(), /stop |enable /);
    assert.equal(await readlink(join(item.base, "current")), item.oldTarget);
  }
});

test("no-sandbox installation is explicit and updates retain its mode and private state", async (t) => {
  const fresh = await fixture(t, { sandbox: false });
  const refused = await fresh.run();
  assert.notEqual(refused.code, 0);
  assert.doesNotMatch(await fresh.serviceLog(), /stop |enable /);
  const installed = await fresh.run({ extra: ["--no-sandbox"] });
  assert.equal(installed.code, 0, installed.stderr);
  assert.equal(JSON.parse(await readFile(fresh.config, "utf8")).sandbox, "disabled");
  assert.match(installed.stderr, /service account permissions/);

  const update = await fixture(t, { existing: true, sandbox: false, installedSandbox: "disabled" });
  const upgraded = await update.run();
  assert.equal(upgraded.code, 0, upgraded.stderr);
  assert.deepEqual(JSON.parse(await readFile(update.config, "utf8")), update.oldConfig);
  assert.equal(
    await readFile(join(update.oldConfig.stateDir, "must-survive"), "utf8"),
    "database fixture",
  );
});

test("sandbox changes require a supporting package and cannot weaken a rejected installation", async (t) => {
  const unsupported = await fixture(t, { existing: true, sandboxModes: ["required"] });
  const unavailable = await unsupported.run({ extra: ["--no-sandbox"] });
  assert.notEqual(unavailable.code, 0);
  assert.match(unavailable.stderr, /does not support no-sandbox mode/);
  assert.doesNotMatch(await unsupported.serviceLog(), /stop |enable /);
  assert.deepEqual(JSON.parse(await readFile(unsupported.config, "utf8")), unsupported.oldConfig);

  const changed = await fixture(t, { existing: true });
  const stale = await changed.run({ extra: ["--no-sandbox", "--expected-sandbox", "disabled"] });
  assert.notEqual(stale.code, 0);
  assert.match(stale.stderr, /Sandbox configuration changed since preflight/);
  assert.doesNotMatch(await changed.serviceLog(), /stop |enable /);
  assert.deepEqual(JSON.parse(await readFile(changed.config, "utf8")), changed.oldConfig);

  const disabled = await fixture(t, {
    existing: true,
    sandbox: false,
    installedSandbox: "disabled",
  });
  const required = await disabled.run({ extra: ["--sandbox"] });
  assert.notEqual(required.code, 0);
  assert.doesNotMatch(await disabled.serviceLog(), /stop |enable /);
  assert.equal(JSON.parse(await readFile(disabled.config, "utf8")).sandbox, "disabled");
  const conflicting = await disabled.run({ extra: ["--sandbox", "--no-sandbox"] });
  assert.notEqual(conflicting.code, 0);
  assert.match(conflicting.stderr, /Choose one sandbox mode/);

  const enabled = await fixture(t, { existing: true, installedSandbox: "disabled" });
  const restored = await enabled.run({ extra: ["--sandbox"] });
  assert.equal(restored.code, 0, restored.stderr);
  assert.deepEqual(JSON.parse(await readFile(enabled.config, "utf8")), {
    ...enabled.oldConfig,
    sandbox: "required",
  });
});
