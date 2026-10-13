# Updates and recovery

Open Settings → Version & updates to inspect Desktop and the selected server
separately. Public update checks and downloads use no GitHub credentials.
Desktop updates include its local server and Web interface; remote servers
are updated independently.

## Desktop

Packaged Desktop checks after startup and then every six hours. Automatic
download is optional. Checks and downloads do not stop Agents or install
software. Failures use bounded backoff.

For macOS ad-hoc releases (including v0.4.0), choose **Download and install manually**.
Quit Intrica, copy the new app from the DMG to Applications, replace the previous
copy and reopen it. Workspace data is preserved. These packages are not notarized
by Apple; if macOS blocks startup, use System Settings → Privacy & Security →
Open Anyway. The app still checks for updates, but disables automatic download
and replacement when the installed app cannot pass trusted signature checks.

For installations supporting automatic replacement, select **Update and restart**. Intrica downloads the matching package, checks
its bytes and application identity, saves drafts and connection state, stops
its local services, replaces the application and starts it again. Background
checks and downloads never trigger installation or exit.

The update journal retains download, verification, installation, restart and
startup-validation states across processes. Completion requires the selected
client version, bundled server version, database schema and original server
identity to match. Remote runs continue while the local connection closes.

Automatic macOS arm64 replacement uses a signed, notarized ZIP and a detached installer. Both the
current app and candidate must pass strict signature checks. Their bundle
identifier and signing team must match. Linux x64 AppImage uses a staged file
beside the installed executable and retains the previous executable. Debian
uses the system permission dialog and package manager, and retains the previous
application files. The current executable must belong to the Intrica package.
A non-writable installation location stops before local services are closed.

When a Developer ID signed and notarized release is available, an old macOS client
that only opens a DMG can open Intrica inside that signed DMG. Its transition launcher offers **Install and restart**, closes
the previous application, replaces it and restarts with the same data folder.
No dragging or manual exit is required. A signed candidate can replace the
legacy ad-hoc bundle; multiple running installation locations are rejected.

Failed downloads do not replace the app. Cancellation removes partial data.
Verified caches are checked again before installation. Installation failures
retain recovery records and the previous executable. A fallback starts only
before new code has launched. Once a candidate can have migrated the database,
the installer retains the evidence and never starts an older binary against it.
Use a compatible newer release or restore a matching full backup.

Build diagnostics include version, channel, commit, build identifier and
recorded build time, without connection credentials. Source builds use
source-update instructions and do not schedule automatic downloads.

## Remote services

Stop new work, wait for active tools to finish and back up before applying
a service update. In Desktop, choose **Install and connect**. The client selects its own
server version, inspects the host and shows installation progress. The archive is verified
locally and remotely before service activation.

From a built source checkout, use a configured SSH alias:

```sh
node scripts/deploy-server.mjs SSH_ALIAS vX.Y.Z
node scripts/deploy-server.mjs SSH_ALIAS vX.Y.Z --update --apply
```

The first command is read-only preflight. The second applies the selected
update. Use the same account and installation directory. Downgrades and
changed confirmation targets are rejected. A failed health check preserves
data and recovery files; it does not automatically run an older binary.

Native updates preserve the saved tool sandbox mode. Select `--no-sandbox`
or `--sandbox` explicitly to change it, and use the same choice for planning
and applying. No-sandbox mode requires declared support in both the public
manifest and archive; it runs tools with the service account's permissions. See
[the mode's requirements](self-hosting.md#explicit-no-sandbox-mode).

For a container, set the existing deployment's `INTRICA_IMAGE` to the new
release's immutable digest, then run:

```sh
docker compose -f compose.release.yaml pull intrica
docker compose -f compose.release.yaml up -d --no-deps --wait intrica
```

Refresh browsers or reconnect clients after server replacement. Keep the
same volumes, data directory and credentials.

## Backups

Quit Desktop before copying its entire data directory:

- macOS: `~/Library/Application Support/Intrica`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/Intrica`

For a native service, stop `intrica-server` with the user service manager
and copy its complete configured state directory plus `server.json`.
For external PostgreSQL or containers, stop all application writers, take a
database backup and copy `DATA_DIR` together. Protect backups as credentials.

## Database migration and uncertain results

Current source uses schema 16. Schemas 11–13 separate file/command grants, preserve
input receipts, and add tracing, media references and resource-change scheduling.
Schemas 14–15 add message deliveries, read/reply deadlines, inbox reviews and
persistent collaboration pause. Schema 16 records model response activity.
Completed tool receipts are retained. Tool schema 5 separates takeover result
resources (`handoffResourceIds`) from resource delegation (`grant_resources`) and
requires an explicit reason for waiting without a current dependency.
Schema 8 and 9 upgrades reconcile persistent
tool receipts and execution state in one transaction. Stop the old API,
Worker and execution processes normally before migration; stopping the
database alone is insufficient.

Completed results and messages are retained. Calls known not to have started
are interrupted. Uncertain side effects remain unconfirmed. Only affected
conversations pause; unread messages, grants and schedule configuration remain.

Review each unconfirmed result, including results from earlier runs.
Confirm a known outcome or abandon the operation. These actions do not
resume the task. After resolving the outcomes, explicitly continue to start
a new run with current tools and permissions. Old arguments are not replayed.

If an upgrade fails, keep the failed instance's data intact. A code downgrade
does not reverse a migration. Restore a matching database and data-directory
backup into an isolated instance using the corresponding application version,
verify its contents, then switch users.

## Download boundaries

Release metadata comes from one fixed public GitHub repository. Node clients
validate the complete manifest and follow only bounded HTTPS release/CDN
redirects. Downloads use pinned version URLs, byte limits and checksums.
Standalone shell installers use fixed public URLs and the matching checksum
file. Checksums verify published bytes; they do not establish trust if the
publisher is compromised.

For networks requiring a proxy, configure `HTTPS_PROXY`, `HTTP_PROXY`,
`NO_PROXY=localhost,127.0.0.1,::1` and `NODE_USE_ENV_PROXY=1` for the
process that performs downloads. Proxy settings in an SSH shell do not
automatically configure a running service.
