import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { downloadAsset, readRelease, selectAsset } from "@intrica/releases";

const versionPattern = /^v(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const aliasPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const stagingPattern = /^\/tmp\/intrica-deploy\.[A-Za-z0-9]{6,20}$/;
export const usage = `Usage: node scripts/deploy-server.mjs SSH_ALIAS vX.Y.Z [--install|--update] [--apply] [--port PORT] [--bind IP]
Without --apply, only inspect the selected SSH host and verified release metadata.
Requires remote Linux x64, non-root, systemd user session,
enabled linger, and Bubblewrap. No sudo, firewall changes, or token transfer.`;

export function parseOptions(args) {
  const [alias, release, ...flags] = args;
  if (!aliasPattern.test(alias ?? "") || !versionPattern.test(release ?? ""))
    throw new Error(usage);
  const options = { alias, release, mode: "auto", apply: false };
  const seen = new Set();
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === "--apply") options.apply = true;
    else if (flag === "--install" || flag === "--update") {
      if (options.mode !== "auto") throw new Error("Choose either --install or --update.");
      options.mode = flag.slice(2);
    } else if (flag === "--port") {
      const value = flags[++index];
      if (!/^\d{1,5}$/.test(value ?? "") || Number(value) < 1 || Number(value) > 65535)
        throw new Error("Port must be an integer from 1 to 65535.");
      options.port = String(Number(value));
    } else if (flag === "--bind") {
      const value = flags[++index];
      if (!isIP(value ?? "")) throw new Error("Bind address must be an IPv4 or IPv6 literal.");
      options.bind = value;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

export function sshArguments(alias, { configuration = false, command } = {}) {
  if (!aliasPattern.test(alias)) throw new Error("Invalid SSH alias.");
  return [
    ...(configuration ? ["-G"] : ["-T"]),
    ...[
      "BatchMode=yes",
      "StrictHostKeyChecking=yes",
      "UpdateHostKeys=no",
      "ConnectTimeout=10",
      "ConnectionAttempts=1",
      "ServerAliveInterval=15",
      "ServerAliveCountMax=2",
      "ClearAllForwardings=yes",
      "ForwardAgent=no",
      "ForwardX11=no",
      "PermitLocalCommand=no",
      "RemoteCommand=none",
      "RequestTTY=no",
      "ControlPath=none",
      "LogLevel=ERROR",
    ].flatMap((option) => ["-o", option]),
    "--",
    alias,
    ...(command ? [command] : []),
  ];
}

// No config/token is returned. An installed runtime is not required for this check.
export const preflightScript = `set -eu
test "$(uname -s)-$(uname -m)" = Linux-x86_64 || { echo 'Only Linux x64 native servers are supported.' >&2; exit 1; }
test "$(id -u)" != 0 || { echo 'Use a regular user, not root.' >&2; exit 1; }
for program in bash systemctl loginctl sha256sum tar flock bwrap; do
  command -v "$program" >/dev/null || { echo "Missing prerequisite: $program. Ask your administrator to install it; no sudo will be run." >&2; exit 1; }
done
test -x /usr/bin/bwrap && /usr/bin/bwrap --unshare-all --die-with-parent --new-session --ro-bind / / --proc /proc --dev /dev /bin/true >/dev/null 2>&1 || { echo 'Working /usr/bin/bwrap and unprivileged namespaces are required. Ask your administrator to configure Bubblewrap; no sudo will be run.' >&2; exit 1; }
systemctl --user show-environment >/dev/null || { echo 'A working systemd user session is required.' >&2; exit 1; }
test "$(loginctl show-user "$(id -un)" -p Linger --value)" = yes || { echo 'Ask your administrator to run: loginctl enable-linger USER. No sudo will be run.' >&2; exit 1; }
base="$HOME/.local/share/intrica-server"
printf 'platform=linux\narchitecture=x64\ninstallation=%s\nconfig=%s\n' "$base" "$HOME/.config/intrica/server.json"
printf 'service=%s\n' "$(systemctl --user is-active intrica-server.service 2>/dev/null || true)"
if test -f "$HOME/.config/intrica/server.json"; then printf 'configured=yes\n'; else printf 'configured=no\n'; fi
if test -L "$base/current"; then printf 'current=%s\n' "$(readlink "$base/current")"; else printf 'current=\n'; fi
printf 'release='
if test -f "$base/current/release.json"; then tr -d '\\r\\n' < "$base/current/release.json"; fi
printf '\n'
if test -x "$base/current/bin/node" && test -f "$HOME/.config/intrica/server.json"; then
  if "$base/current/bin/node" --input-type=module - "$HOME/.config/intrica/server.json" "$base/current/release.json" >/dev/null 2>&1 <<'JS'
import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(process.argv[2]));
const expected = JSON.parse(readFileSync(process.argv[3]));
let host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host;
if (host.includes(':')) host = '[' + host + ']';
const url = 'http://' + host + ':' + config.port;
const ready = await fetch(url + '/api/v2/ready', {signal:AbortSignal.timeout(3000)});
if (!ready.ok) process.exit(1);
const response = await fetch(url + '/api/v2/settings/version', {headers:{Authorization:'Bearer ' + config.accessToken}, signal:AbortSignal.timeout(3000)});
const result = await response.json();
process.exit(response.ok && result.version === expected.version && result.commit === expected.commit && result.deployment === 'service' ? 0 : 1);
JS
  then printf 'healthy=yes\n'; else printf 'healthy=no\n'; fi
else printf 'healthy=no\n'; fi
`;

function parseLines(output) {
  const fields = {};
  for (const line of output.trim().split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("Unexpected SSH preflight response.");
    const key = line.slice(0, separator);
    if (Object.hasOwn(fields, key)) throw new Error("Duplicate SSH preflight field.");
    fields[key] = line.slice(separator + 1);
  }
  return fields;
}

export function parsePreflight(output) {
  const result = parseLines(output);
  if (
    result.platform !== "linux" ||
    result.architecture !== "x64" ||
    !result.installation?.startsWith("/") ||
    !result.config?.startsWith("/") ||
    !["yes", "no"].includes(result.configured) ||
    !["yes", "no"].includes(result.healthy) ||
    !["active", "inactive", "failed", "unknown", ""].includes(result.service)
  )
    throw new Error("Incomplete SSH preflight response.");
  if (result.release) {
    try {
      result.version = JSON.parse(result.release).version;
    } catch {
      throw new Error("Installed release metadata is malformed; manual recovery is required.");
    }
    if (!versionPattern.test(`v${result.version}`))
      throw new Error("Installed release version is unsupported; manual recovery is required.");
  }
  return result;
}

export function planDeployment(options, host, asset) {
  if (options.mode === "install" && (host.version || host.configured === "yes"))
    throw new Error("Server configuration already exists; use --update or automatic mode.");
  if (options.mode === "update" && (!host.version || host.configured !== "yes"))
    throw new Error("No complete existing installation was found for --update.");
  if (host.version) {
    const current = host.version.split(".").map(Number);
    const desired = options.release.slice(1).split(".").map(Number);
    const differing = current.findIndex((part, index) => part !== desired[index]);
    if (differing !== -1 && current[differing] > desired[differing])
      throw new Error("Downgrades are refused: database migrations may not be reversible.");
  }
  const expectedTarget = `${host.installation}/releases/${options.release}-${asset.sha256.slice(0, 12)}`;
  const unchanged =
    host.current === expectedTarget &&
    host.configured === "yes" &&
    host.service === "active" &&
    host.healthy === "yes" &&
    !options.port &&
    !options.bind;
  return {
    mode: options.apply ? "apply" : "plan",
    alias: options.alias,
    platform: `${host.platform}-${host.architecture}`,
    action: unchanged ? "no-op" : host.version ? "update" : "install",
    release: options.release,
    installation: host.installation,
    config: host.config,
    currentVersion: host.version ?? null,
    service: host.service || "unknown",
    healthy: host.healthy === "yes",
    preserve: ["access token", "database password", "state directory", "existing settings"],
    listen: {
      bind: options.bind ?? "preserve existing; otherwise 127.0.0.1",
      port: options.port ?? "preserve existing; otherwise 3001",
    },
    asset: { name: asset.name, size: asset.size, sha256: asset.sha256 },
    note: "Apply stops/restarts only this user's service after validation. No data deletion or automatic database rollback. No sudo or firewall changes.",
  };
}

// Arguments are never evaluated by a local shell. Only validated constants and
// the validated remote mktemp path enter the remote command; script bytes use stdin.
export async function runCommand(command, args, { input, inputFile, timeout = 30_000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(env ? { env } : {}),
    });
    let stdout = "";
    let stderr = "";
    let failure;
    let killTimer;
    let source;
    const fail = (error) => {
      if (failure) return;
      failure = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const timer = setTimeout(() => fail(new Error(`${command} exceeded its time limit.`)), timeout);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      source?.destroy();
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      stdout += data;
      if (stdout.length > 1024 * 1024) fail(new Error(`${command} output limit exceeded.`));
    });
    child.stderr.on("data", (data) => {
      stderr += data;
      if (stderr.length > 1024 * 1024) fail(new Error(`${command} output limit exceeded.`));
    });
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0)
        reject(new Error(`${command} failed (${code}): ${stderr.trim().slice(0, 4000)}`));
      else resolve(stdout);
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") fail(error);
    });
    if (inputFile) {
      source = createReadStream(inputFile);
      source.on("error", fail).pipe(child.stdin);
    } else child.stdin.end(input);
  });
}

export async function deployServer(
  options,
  { run = runCommand, log = console.log, expectedPlan, fetchImpl = fetch } = {},
) {
  if (!["auto", "install", "update"].includes(options.mode) || typeof options.apply !== "boolean")
    throw new Error("Invalid deployment mode.");
  options = parseOptions([
    options.alias,
    options.release,
    ...(options.mode === "auto" ? [] : [`--${options.mode}`]),
    ...(options.apply ? ["--apply"] : []),
    ...(options.port === undefined ? [] : ["--port", options.port]),
    ...(options.bind === undefined ? [] : ["--bind", options.bind]),
  ]);
  const configuration = await run("ssh", sshArguments(options.alias, { configuration: true }));
  const user = configuration.match(/^user (.+)$/m)?.[1];
  const hostname = configuration.match(/^hostname (.+)$/m)?.[1];
  if (
    !user ||
    user === "root" ||
    !hostname ||
    [...hostname].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("SSH alias must resolve to a non-root user and a valid hostname.");
  const host = parsePreflight(
    await run("ssh", sshArguments(options.alias, { command: "bash -s --" }), {
      input: preflightScript,
    }),
  );
  const metadata = await readRelease(options.release.slice(1), fetchImpl);
  const asset = selectAsset(metadata, "server-linux-x64.tar.gz");
  const plan = planDeployment(options, host, asset);
  plan.sshTarget = `${user}@${hostname}:${configuration.match(/^port (.+)$/m)?.[1] ?? "22"}`;
  if (
    expectedPlan &&
    ["alias", "sshTarget", "release", "installation", "config", "currentVersion", "action"].some(
      (key) => plan[key] !== expectedPlan[key],
    )
  )
    throw new Error("Deployment target changed since preflight. Run preflight again.");
  if (expectedPlan && plan.asset.sha256 !== expectedPlan.asset.sha256)
    throw new Error("Release changed since preflight. Run preflight again.");
  log(JSON.stringify(plan, null, 2));
  if (!options.apply || plan.action === "no-op") return plan;

  const temporary = await mkdtemp(join(tmpdir(), "intrica-deploy-"));
  let remoteDirectory;
  try {
    const archive = join(temporary, "server.tar.gz");
    log("Downloading and verifying the pinned public package locally.");
    await downloadAsset(metadata.version, asset, archive, { fetchImpl });
    remoteDirectory = (
      await run("ssh", sshArguments(options.alias, { command: "bash -s --" }), {
        input: "umask 077\nmktemp -d /tmp/intrica-deploy.XXXXXXXXXX\n",
      })
    ).trim();
    if (!stagingPattern.test(remoteDirectory)) {
      remoteDirectory = undefined;
      throw new Error("Remote staging directory was not valid; refusing transfer and cleanup.");
    }
    log("Transferring verified package over SSH; the existing service is still running.");
    await run(
      "ssh",
      sshArguments(options.alias, {
        command: `dd of='${remoteDirectory}/server.tar.gz' status=none`,
      }),
      { inputFile: archive, timeout: 15 * 60_000 },
    );
    const parameters = [
      options.release,
      "--archive",
      `${remoteDirectory}/server.tar.gz`,
      "--sha256",
      asset.sha256,
      "--size",
      String(asset.size),
    ];
    if (options.port) parameters.push("--port", options.port);
    if (options.bind) parameters.push("--bind", options.bind);
    const script = await readFile(new URL("./install-server.sh", import.meta.url), "utf8");
    log("Installing and checking authenticated health; access tokens are not returned or logged.");
    const result = await run(
      "ssh",
      sshArguments(options.alias, {
        command: `bash -s -- ${parameters.map((parameter) => `'${parameter}'`).join(" ")}`,
      }),
      { input: script, timeout: 10 * 60_000 },
    );
    log(result.trim());
    log(
      "Connect through an SSH tunnel (new installs bind loopback). Retrieve the access token privately from the remote config file; it was not copied to this computer.",
    );
    return { ...plan, completed: true };
  } finally {
    if (remoteDirectory) {
      try {
        await run("ssh", sshArguments(options.alias, { command: "bash -s --" }), {
          input: `rm -f -- '${remoteDirectory}/server.tar.gz'\nrmdir -- '${remoteDirectory}'\n`,
        });
      } catch {
        log(
          `Staged archive remains at ${remoteDirectory}/server.tar.gz; remove it when the host is reachable.`,
        );
      }
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.includes("--help")) console.log(usage);
  else {
    try {
      await deployServer(parseOptions(process.argv.slice(2)));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
