#!/usr/bin/env bash
set -euo pipefail
umask 077

release=${1:?Usage: bash install-server.sh vX.Y.Z [--sandbox|--no-sandbox] [--port PORT] [--bind IP] [--archive FILE --sha256 DIGEST --size BYTES]}
shift
port=
bind=
archive=
archive_digest=
archive_size=
sandbox=
expected_sandbox=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sandbox|--no-sandbox)
      if [[ -n "$sandbox" ]]; then echo 'Choose one sandbox mode.' >&2; exit 1; fi
      if [[ "$1" == --sandbox ]]; then sandbox=required; else sandbox=disabled; fi
      shift ;;
    --expected-sandbox)
      expected_sandbox=${2:?Missing expected sandbox mode}
      case "$expected_sandbox" in required|disabled|unconfigured) ;; *) echo 'Invalid expected sandbox mode.' >&2; exit 1 ;; esac
      shift 2 ;;
    --port) port=${2:?Missing port}; shift 2 ;;
    --bind) bind=${2:?Missing bind address}; shift 2 ;;
    --archive) archive=${2:?Missing archive}; shift 2 ;;
    --sha256) archive_digest=${2:?Missing digest}; shift 2 ;;
    --size) archive_size=${2:?Missing size}; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
if [[ ! "$release" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo 'Expected a pinned stable release tag: vMAJOR.MINOR.PATCH.' >&2
  exit 1
fi
if [[ -n "$port" && (! "$port" =~ ^[0-9]+$ || ${#port} -gt 5) ]]; then
  echo 'Port must be an integer from 1 to 65535.' >&2
  exit 1
fi
if [[ -n "$port" ]] && ((10#$port < 1 || 10#$port > 65535)); then
  echo 'Port must be an integer from 1 to 65535.' >&2
  exit 1
fi
if [[ -n "$archive" || -n "$archive_digest" || -n "$archive_size" ]]; then
  if [[ ! -f "$archive" || ! "$archive_digest" =~ ^[a-f0-9]{64}$ || ! "$archive_size" =~ ^[1-9][0-9]*$ ]]; then
    echo 'A local archive requires its release SHA-256 digest and byte size.' >&2
    exit 1
  fi
fi
if [[ "$(uname -s)-$(uname -m)" != Linux-x86_64 || $(id -u) == 0 ]]; then
  echo 'Run as your regular development user on Linux x64 with systemd, not as root.' >&2
  exit 1
fi
for command in systemctl loginctl sha256sum tar flock; do
  command -v "$command" >/dev/null || { echo "Required command: $command" >&2; exit 1; }
done
if [[ -z "$archive" ]]; then
  command -v curl >/dev/null || { echo 'Required command: curl (or pass a verified --archive)' >&2; exit 1; }
fi
systemctl --user show-environment >/dev/null || {
  echo 'A systemd user session is required. Log in directly over SSH as your development user.' >&2
  exit 1
}
if [[ "$(loginctl show-user "$(id -un)" -p Linger --value)" != yes ]]; then
  echo 'A system administrator must enable linger for this user before installation (loginctl enable-linger USER).' >&2
  exit 1
fi

base="$HOME/.local/share/intrica-server"
config_dir="$HOME/.config/intrica"
unit_dir="$HOME/.config/systemd/user"
mkdir -p "$base/releases" "$config_dir" "$unit_dir"
exec 9> "$base/install.lock"
flock -n 9 || { echo 'Another Intrica Server installation is in progress.' >&2; exit 1; }
temporary=$(mktemp -d "$base/.install.XXXXXX")
recovery=
activation_started=
cleanup() {
  status=$?
  if [[ "$status" != 0 && -n "$recovery" ]]; then
    if [[ -n "$activation_started" ]]; then systemctl --user stop intrica-server.service || true; fi
    echo "Installation failed. Data was preserved; recovery files: $recovery" >&2
    echo 'Do not restart an older package until database migration compatibility is checked.' >&2
  fi
  rm -rf "$temporary"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

download_public() {
  local name=$1 destination=$2 url="https://github.com/M0gician/intrica/releases/download/$release/$1" next hop
  for hop in 0 1 2 3; do
    next=$(curl -q --fail --show-error --progress-bar --proto '=https' \
      --connect-timeout 15 --max-time 900 --max-filesize 2147483648 \
      --output "$destination" --write-out '%{redirect_url}' "$url") || return
    if [[ -z "$next" ]]; then return 0; fi
    case "$next" in
      "https://github.com/M0gician/intrica/releases/download/$release/$name"|https://release-assets.githubusercontent.com/*|https://objects.githubusercontent.com/*) url=$next ;;
      *) echo 'Untrusted release redirect.' >&2; return 1 ;;
    esac
  done
  echo 'Too many release redirects.' >&2
  return 1
}

echo "[1/5] Downloading native Intrica Server ${release}…"
asset="Intrica-${release#v}-server-linux-x64.tar.gz"
if [[ -n "$archive" ]]; then
  size=$archive_size
  digest="sha256:$archive_digest"
  cp "$archive" "$temporary/server.tar.gz"
else
  download_public SHA256SUMS "$temporary/SHA256SUMS"
  expected=$(awk -v name="./$asset" '$2 == name { print $1 }' "$temporary/SHA256SUMS")
  if [[ ! "$expected" =~ ^[a-f0-9]{64}$ ]]; then
    echo 'Missing or duplicate server checksum.' >&2
    exit 1
  fi
  download_public "$asset" "$temporary/server.tar.gz"
  size=$(wc -c < "$temporary/server.tar.gz" | tr -d ' ')
  digest="sha256:$expected"
fi

echo '[2/5] Verifying and unpacking the server…'
if [[ "$(wc -c < "$temporary/server.tar.gz" | tr -d ' ')" != "$size" ]]; then
  echo 'Server package size mismatch.' >&2
  exit 1
fi
if ! printf '%s  %s\n' "${digest#sha256:}" "$temporary/server.tar.gz" | sha256sum --check --status; then
  echo 'Server package SHA-256 mismatch.' >&2
  exit 1
fi
tar -tzf "$temporary/server.tar.gz" | while IFS= read -r entry; do
  if [[ "$entry" == /* || "$entry" =~ (^|/)\.\.(/|$) ]]; then
    echo 'Unsafe archive path.' >&2
    exit 1
  fi
done
mkdir "$temporary/app"
tar --no-same-owner --no-same-permissions -xzf "$temporary/server.tar.gz" -C "$temporary/app"
node="$temporary/app/bin/node"
"$node" --version

echo '[3/5] Configuring your user service…'
"$node" --input-type=module - "$config_dir/server.json" "$temporary/server.json" "$port" "$bind" "$temporary/app/release.json" "${release#v}" "$base/current" "$sandbox" "$expected_sandbox" <<'JS'
import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { isIP } from 'node:net';
import { join } from 'node:path';
const [file, output, port, host, releaseFile, version, current, sandbox, expectedSandbox] = process.argv.slice(2);
const release = JSON.parse(readFileSync(releaseFile));
if (release.version !== version) throw new Error('Package version mismatch');
// The SSH plan can be stale after its local download. Recheck under install.lock,
// before stopping the service, including when this installer is invoked directly.
const parseVersion = (value) => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    throw new Error('Invalid stable release version; manual recovery is required.');
  return value.split('.').map(BigInt);
};
const compareVersions = (left, right) => {
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
};
const candidate = parseVersion(version);
let installed = false;
try { lstatSync(current); installed = true; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (installed) {
  let previous;
  try { previous = JSON.parse(readFileSync(join(current, 'release.json'))).version; }
  catch { throw new Error('Cannot read installed release metadata; manual recovery is required.'); }
  if (compareVersions(parseVersion(previous), candidate) > 0)
    throw new Error('Downgrades are refused: database migrations may not be reversible.');
}
let config, configured = true;
try { config = JSON.parse(readFileSync(file)); }
catch (error) {
  if (error.code !== 'ENOENT') throw new Error('Cannot read server configuration. Its private contents were not logged.');
  configured = false;
  config = { host:'127.0.0.1', port:3001, accessToken:randomBytes(32).toString('hex'), databasePassword:randomBytes(32).toString('hex'),
    stateDir:join(homedir(), '.local/share/intrica-server/state'), serverName:`Intrica on ${hostname()}` };
}
if (expectedSandbox && expectedSandbox !== (configured ? (config.sandbox ?? 'required') : 'unconfigured'))
  throw new Error('Sandbox configuration changed since preflight. Inspect the host and confirm a new plan.');
if (port) config.port = Number(port);
if (host) config.host = host;
config.sandbox = sandbox || (config.sandbox ?? 'required');
if (!['required','disabled'].includes(config.sandbox)) throw new Error('Invalid sandbox mode');
if (config.sandbox === 'disabled' && (!Array.isArray(release.sandboxModes) || !release.sandboxModes.includes('disabled')))
  throw new Error('This server package does not support no-sandbox mode. Select a package that declares this capability.');
if (!isIP(config.host) || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
    !config.accessToken || !config.databasePassword || !config.stateDir) throw new Error('Invalid server configuration');
writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, {mode:0o600});
JS
sandbox=$("$node" --input-type=module -e 'import {readFileSync} from "node:fs"; process.stdout.write(JSON.parse(readFileSync(process.argv[1])).sandbox);' "$temporary/server.json")
if [[ "$sandbox" == required ]]; then
  if [[ ! -x /usr/bin/bwrap ]] || ! /usr/bin/bwrap --unshare-all --die-with-parent --new-session --ro-bind / / --proc /proc --dev /dev /bin/true >/dev/null 2>&1; then
    echo 'Working /usr/bin/bwrap with unprivileged namespaces is required. Configure Bubblewrap or explicitly select --no-sandbox. No service changes were applied.' >&2
    exit 1
  fi
else
  echo 'No-sandbox mode: tools run with the service account permissions. Working directories do not restrict file or network access.' >&2
fi
target="$base/releases/${release}-${digest:7:12}"
if [[ ! -d "$target" ]]; then mv "$temporary/app" "$target"; fi
node="$target/bin/node"
"$node" --input-type=module - "$temporary/intrica-server.service" <<'JS'
import { writeFileSync } from 'node:fs';
const path = JSON.stringify(`PATH=${process.env.PATH}`).replaceAll('%', '%%');
writeFileSync(process.argv[2], `[Unit]
Description=Intrica Server
After=network.target

[Service]
Type=simple
WorkingDirectory=%h
ExecStart="%h/.local/share/intrica-server/current/bin/intrica-server"
Environment="INTRICA_SERVICE_CONFIG=%h/.config/intrica/server.json"
Environment=${path}
Restart=on-failure
RestartSec=3
KillMode=mixed
TimeoutStopSec=60
UMask=0077

[Install]
WantedBy=default.target
`);
JS

echo '[4/5] Starting Intrica and enabling startup after reboot…'
mkdir -p "$base/recovery"
recovery=$(mktemp -d "$base/recovery/${release}.XXXXXX")
if [[ -f "$config_dir/server.json" ]]; then cp -p "$config_dir/server.json" "$recovery/server.json"; fi
if [[ -f "$unit_dir/intrica-server.service" ]]; then cp -p "$unit_dir/intrica-server.service" "$recovery/intrica-server.service"; fi
if [[ -L "$base/current" ]]; then readlink "$base/current" > "$recovery/previous-release.txt"; fi
printf '%s\n' "$target" > "$recovery/requested-release.txt"
printf 'prepared\n' > "$recovery/phase"
if systemctl --user cat intrica-server.service >/dev/null 2>&1; then
  systemctl --user stop intrica-server.service
fi
install -m 600 "$temporary/server.json" "$config_dir/server.json"
install -m 644 "$temporary/intrica-server.service" "$unit_dir/intrica-server.service"
ln -s "$target" "$temporary/current"
mv -Tf "$temporary/current" "$base/current"
systemctl --user daemon-reload
activation_started=yes
printf 'activating\n' > "$recovery/phase"
systemctl --user enable --now intrica-server.service
if ! "$node" --input-type=module - "$config_dir/server.json" "$target/release.json" <<'JS'
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
let config;
try { config = JSON.parse(readFileSync(process.argv[2])); }
catch { process.exit(1); }
const expected = JSON.parse(readFileSync(process.argv[3]));
let host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host;
if (host.includes(':')) host = `[${host}]`;
const url = `http://${host}:${config.port}`;
for (let attempt = 0; attempt < 90; attempt++) {
  try {
    const ready = await fetch(`${url}/api/v2/ready`, {signal:AbortSignal.timeout(2000)});
    if (ready.ok) {
      const response = await fetch(`${url}/api/v2/settings/version`, {
        headers:{Authorization:`Bearer ${config.accessToken}`}, signal:AbortSignal.timeout(2000)});
      const version = await response.json();
      if (response.ok && version.version === expected.version && version.commit === expected.commit && version.deployment === 'service') process.exit(0);
    }
  } catch {}
  await setTimeout(1000);
}
process.exit(1);
JS
then
  systemctl --user stop intrica-server.service
  echo 'Startup failed. Data was preserved. Inspect: journalctl --user -u intrica-server -n 80' >&2
  exit 1
fi
systemctl --user is-active --quiet intrica-server.service
activation_started=
printf 'healthy\n' > "$recovery/phase"

echo '[5/5] Intrica Server is ready. It will keep running after SSH disconnects and start on boot.'
"$node" --input-type=module - "$config_dir/server.json" <<'JS'
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
let config;
try { config = JSON.parse(readFileSync(process.argv[2])); }
catch { throw new Error('Cannot read server configuration. Its private contents were not logged.'); }
const sshAddress = process.env.SSH_CONNECTION?.trim().split(/\s+/)[2];
const addresses = ['0.0.0.0','::'].includes(config.host)
  ? (sshAddress ? [sshAddress] : [...new Set(Object.values(networkInterfaces()).flat()
      .filter(a => a.family === 'IPv4' && !a.internal).map(a => a.address))])
  : [config.host];
console.log('Desktop → Settings → Servers → Add:');
for (const address of addresses) console.log(`  Address: http://${address.includes(':') ? `[${address}]` : address}:${config.port}`);
console.log(`  Access token: stored in ${process.argv[2]} (never printed by the installer)`);
console.log(`Configuration: ${process.argv[2]}`);
JS
echo 'Status: systemctl --user status intrica-server'
echo 'Logs:   journalctl --user -u intrica-server -f'
