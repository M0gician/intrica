import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseManifest } from "@intrica/releases";
import { releaseManifest } from "../tests/fixtures/releases.mjs";
import {
  deployServer,
  parseOptions,
  parsePreflight,
  planDeployment,
  preflightScript,
  runCommand,
  sshArguments,
} from "./deploy-server.mjs";

const archive = Buffer.from("test-only native server archive");
const digest = createHash("sha256").update(archive).digest("hex");
const release = "v0.2.6";
const metadata = releaseManifest("0.2.6", archive);
const host = {
  platform: "linux",
  architecture: "x64",
  installation: "/home/example/.local/share/intrica-server",
  config: "/home/example/.config/intrica/server.json",
  configured: "no",
  current: "",
  release: "",
  service: "inactive",
  healthy: "no",
  sandbox: "required",
  sandboxAvailable: "yes",
};
const options = parseOptions(["chosen-alias", release]);
const preflight = (value = host) =>
  Object.entries(value)
    .map(([key, item]) => `${key}=${item}`)
    .join("\n");

function fakeRuntime({
  remote = host,
  corrupt = false,
  installError = false,
  staging = "/tmp/intrica-deploy.ABCDE12345",
  root = false,
  manifest = metadata,
} = {}) {
  const calls = [];
  const logs = [];
  const network = [];
  return {
    calls,
    logs,
    network,
    fetchImpl: async (url) => {
      network.push(url);
      if (url.endsWith("/intrica-update.json")) return Response.json(manifest);
      return new Response(corrupt ? Buffer.alloc(archive.length) : archive);
    },
    log: (message) => logs.push(message),
    async run(command, args, input = {}) {
      calls.push({ command, args, ...input });
      if (command === "ssh" && args.includes("-G"))
        return `user ${root ? "root" : "example"}\nhostname 10.0.0.9\n`;
      if (command === "ssh" && input.input === preflightScript) return preflight(remote);
      if (command === "ssh" && input.input?.startsWith("umask 077\nmktemp")) return `${staging}\n`;
      if (command === "ssh" && input.inputFile) {
        assert.deepEqual(await readFile(input.inputFile), archive);
        return "";
      }
      if (command === "ssh" && input.input?.startsWith("#!/usr/bin/env bash")) {
        if (installError) throw new Error("health check failed; recovery files remain");
        return "Intrica ready. Access token: stored in remote config (not printed to logs).";
      }
      if (command === "ssh" && input.input?.startsWith("rm -f --")) return "";
      throw new Error("Unexpected command");
    },
  };
}

test("CLI defaults to a plan for exactly one validated SSH alias and pinned stable tag", () => {
  assert.equal(options.apply, false);
  for (const alias of ["--host", "a;id", "$(id)", "u@host", "host name", "x\nfoo", "a/b"])
    assert.throws(() => parseOptions([alias, release]));
  for (const version of ["latest", "v0.2.6;id", "v0.2.6-preview", "v01.2.3"])
    assert.throws(() => parseOptions(["valid", version]));
  assert.throws(() => parseOptions(["valid", release, "--port", "70000"]));
  assert.throws(() => parseOptions(["valid", release, "--bind", "127.0.0.1;id"]));
  assert.throws(() => parseOptions(["valid", release, "--apply", "--apply"]));
  assert.throws(() => parseOptions(["valid", release, "--install", "--update"]));
  assert.throws(() => parseOptions(["valid", release, "--sandbox", "--no-sandbox"]));
  assert.equal(parseOptions(["valid", release, "--bind", "::1", "--port", "03001"]).port, "3001");
});

test("remote doctor script is valid Bash and subprocess timeouts are bounded", async () => {
  await runCommand("bash", ["-n"], { input: preflightScript });
  await assert.rejects(
    runCommand(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
      timeout: 100,
    }),
    /exceeded its time limit/,
  );
});

test("programmatic deployment API revalidates options before invoking SSH", async () => {
  const runtime = fakeRuntime();
  await assert.rejects(
    deployServer({ ...options, bind: "127.0.0.1'; id; #" }, runtime),
    /Bind address/,
  );
  assert.equal(runtime.calls.length, 0);
  await assert.rejects(deployServer({ ...options, sandbox: "auto" }, runtime), /Invalid sandbox/);
  assert.equal(runtime.calls.length, 0);
});

test("SSH preserves alias resolution but overrides interactive, trust and forwarding defaults", () => {
  const args = sshArguments("chosen-alias", { command: "bash -s --" });
  for (const flag of [
    "BatchMode=yes",
    "StrictHostKeyChecking=yes",
    "UpdateHostKeys=no",
    "ConnectTimeout=10",
    "ForwardAgent=no",
    "PermitLocalCommand=no",
    "RemoteCommand=none",
    "ControlPath=none",
  ])
    assert.ok(args.includes(flag));
  assert.deepEqual(args.slice(-3), ["--", "chosen-alias", "bash -s --"]);
  assert.ok(!args.includes("StrictHostKeyChecking=accept-new"));
});

test("preflight is read-only and reports only non-secret installation/service fields", () => {
  assert.deepEqual(parsePreflight(preflight()), host);
  assert.doesNotMatch(
    preflightScript,
    /^\s*(sudo |mkdir |rm -|systemctl --user enable |loginctl enable-linger )/m,
  );
  assert.match(preflightScript, /Missing prerequisite/);
  assert.match(preflightScript, /Only Linux x64/);
  assert.match(preflightScript, /Authorization:'Bearer ' \+ config.accessToken/);
  assert.doesNotMatch(preflightScript, /console\.log/);
  assert.throws(() => parsePreflight(`${preflight()}\nservice=active`));
  assert.throws(() => parsePreflight(preflight({ ...host, architecture: "arm64" })));
  assert.throws(() => parsePreflight(preflight({ ...host, release: "not-json" })));
});

test("plan refuses downgrade or mode mismatch and no-ops only for exact healthy active package", () => {
  const manifest = parseManifest(metadata);
  assert.throws(
    () => planDeployment({ ...options, mode: "update" }, host, manifest),
    /No complete/,
  );
  assert.throws(
    () => planDeployment({ ...options, mode: "install" }, { ...host, configured: "yes" }, manifest),
    /already exists/,
  );
  assert.throws(
    () => planDeployment(options, { ...host, version: "0.3.0" }, manifest),
    /Downgrades/,
  );
  const installed = {
    ...host,
    configured: "yes",
    version: "0.2.6",
    service: "active",
    healthy: "yes",
    current: `${host.installation}/releases/${release}-${digest.slice(0, 12)}`,
  };
  assert.equal(planDeployment(options, installed, manifest).action, "no-op");
  for (const mutation of [
    { service: "failed" },
    { healthy: "no" },
    { current: "/preview-same-version" },
  ])
    assert.equal(planDeployment(options, { ...installed, ...mutation }, manifest).action, "update");
  assert.equal(planDeployment({ ...options, port: "3002" }, installed, manifest).action, "update");
});

test("no-sandbox deployment needs advertised release support before download or remote writes", async () => {
  for (const modes of [undefined, ["required"]]) {
    for (const apply of [false, true]) {
      const runtime = fakeRuntime({ manifest: { ...metadata, serverSandboxModes: modes } });
      await assert.rejects(
        deployServer({ ...options, apply, sandbox: "disabled" }, runtime),
        /does not declare no-sandbox support/,
      );
      assert.equal(runtime.calls.length, 2);
      assert.ok(runtime.network.every((url) => url.endsWith("/intrica-update.json")));
    }
  }
});

test("default plan never downloads, creates staging, or restarts the selected host", async () => {
  const runtime = fakeRuntime();
  const result = await deployServer(options, runtime);
  assert.equal(result.action, "install");
  assert.equal(runtime.calls.length, 2);
  assert.deepEqual(
    runtime.calls.map((call) => call.command),
    ["ssh", "ssh"],
  );
  assert.ok(runtime.calls.every((call) => !call.inputFile));
  assert.match(runtime.logs.join("\n"), /preserve existing; otherwise 127.0.0.1/);
});

test("apply verifies locally before transfer and installer uses stdin without credentials", async () => {
  const runtime = fakeRuntime();
  const result = await deployServer({ ...options, apply: true }, runtime);
  assert.equal(result.completed, true);
  const installer = runtime.calls.find((call) => call.input?.startsWith("#!/usr/bin/env bash"));
  assert.match(installer.args.at(-1), /bash -s -- 'v0.2.6' '--archive'/);
  assert.doesNotMatch(installer.args.join(" "), /accessToken|databasePassword|GH_TOKEN/);
  assert.equal(runtime.calls.filter((call) => call.inputFile).length, 1);
  assert.match(runtime.calls.at(-1).input, /^rm -f -- '\/tmp\/intrica-deploy\./);
  assert.equal(runtime.calls.at(-1).input.includes("rm -rf"), false);
});

test("corrupt local download fails before any remote write", async () => {
  const runtime = fakeRuntime({ corrupt: true });
  await assert.rejects(
    deployServer({ ...options, apply: true }, runtime),
    /UPDATE_CHECKSUM_FAILED/,
  );
  assert.equal(runtime.calls.filter((call) => call.command === "ssh").length, 2);
});

test("unknown host key/auth/preflight failures do not invoke release installation", async () => {
  const runtime = fakeRuntime({ root: true });
  await assert.rejects(deployServer({ ...options, apply: true }, runtime), /non-root/);
  assert.equal(runtime.calls.length, 1);
  await assert.rejects(
    deployServer(options, {
      run: async () => {
        throw new Error("Host key verification failed.");
      },
      log() {},
    }),
    /Host key/,
  );
});

test("remote staging injection is rejected without destructive cleanup", async () => {
  const runtime = fakeRuntime({ staging: "/tmp/intrica-deploy.AAAAAA'; touch /tmp/pwned; #" });
  await assert.rejects(deployServer({ ...options, apply: true }, runtime), /staging directory/);
  assert.ok(runtime.calls.every((call) => !call.inputFile));
  assert.ok(runtime.calls.every((call) => !call.input?.startsWith("rm -f")));
});

test("installation failure still removes only known staged archive and preserves recovery diagnostics", async () => {
  const runtime = fakeRuntime({ installError: true });
  await assert.rejects(deployServer({ ...options, apply: true }, runtime), /recovery files remain/);
  assert.match(runtime.calls.at(-1).input, /^rm -f --/);
  assert.doesNotMatch(runtime.calls.at(-1).input, /\.config|\.local|state/);
});

test("confirmed Desktop plan refuses changed SSH identity, installation state or release digest before download", async () => {
  const preflight = await deployServer(options, fakeRuntime());
  for (const changed of [
    { ...preflight, sshTarget: "somebody@other-host:22" },
    { ...preflight, installation: "/home/other/.local/share/intrica-server" },
    { ...preflight, asset: { ...preflight.asset, sha256: "0".repeat(64) } },
    { ...preflight, sandbox: "disabled" },
    { ...preflight, currentSandbox: "disabled" },
  ]) {
    const runtime = fakeRuntime();
    await assert.rejects(
      deployServer({ ...options, apply: true }, { ...runtime, expectedPlan: changed }),
      /changed since preflight/,
    );
    assert.ok(runtime.network.every((url) => url.endsWith("/intrica-update.json")));
  }
});

test("unavailable isolation requires explicit no-sandbox selection and the confirmed mode reaches installation", async () => {
  const remote = { ...host, sandboxAvailable: "no" };
  const blocked = fakeRuntime({ remote });
  await assert.rejects(deployServer(options, blocked), /explicitly choose --no-sandbox/);
  assert.ok(blocked.calls.every((call) => !call.inputFile));

  const input = parseOptions(["chosen-alias", release, "--no-sandbox"]);
  const planned = await deployServer(input, fakeRuntime({ remote }));
  assert.equal(planned.sandbox, "disabled");
  const applied = fakeRuntime({ remote });
  await deployServer({ ...input, apply: true }, { ...applied, expectedPlan: planned });
  const installer = applied.calls.find((call) => call.input?.startsWith("#!/usr/bin/env bash"));
  assert.match(installer.args.at(-1), /'--no-sandbox'/);

  const changed = fakeRuntime({ remote });
  await assert.rejects(
    deployServer(
      { ...input, sandbox: "required", apply: true },
      { ...changed, expectedPlan: planned },
    ),
    /Sandbox unavailable/,
  );
  assert.ok(changed.calls.every((call) => !call.inputFile));

  const installed = { ...remote, configured: "yes", sandbox: "disabled", version: "0.2.5" };
  assert.equal(
    (await deployServer(options, fakeRuntime({ remote: installed }))).sandbox,
    "disabled",
  );
});
