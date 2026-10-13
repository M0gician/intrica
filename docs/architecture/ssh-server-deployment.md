# SSH server deployment

Desktop and the source CLI use `scripts/deploy-server.mjs` for the same
preflight, package selection and installation process. Desktop lists SSH
configuration aliases and also accepts an explicit host, username and port.

## Inspection and installation

The default CLI invocation is read-only:

```sh
node scripts/deploy-server.mjs SSH_ALIAS vX.Y.Z
```

The host must be Linux x64, use a non-root account, support a systemd user
session with linger. Inspection is read-only and distinguishes disabled linger,
query failures and an unavailable user manager from unsupported platforms.
It reports Bubblewrap availability and the
installed sandbox mode. Planning requires working isolation unless the
selected mode is explicitly `disabled`; a new installation defaults to
`required`. The helper does not configure sudo, namespaces, firewall rules
or SSH host trust.

Preflight reports installation and service state without returning secrets.
Desktop selects the server release from its own packaged version. The renderer
cannot choose a release. **Install and connect** runs inspection and the internal
deployment plan, then rechecks SSH identity, installation state, execution mode
and artifact hash. Changed targets stop the operation.

During installation, the shared prerequisite function from the standalone installer
can enable linger for the remote effective UID with `loginctl --no-ask-password`.
It never invokes sudo or changes host policy. Preparation must pass a second
linger and user-manager check before service changes. Failed queries are not
treated as disabled settings. Failed preparation does not stop the existing service.
An enabled linger setting is retained after later failures because other user
services may depend on it.

A main-process operation ID owns installation progress, cancellation and recovery.
The operation persists without credentials. Leaving the settings panel does not
stop it. Download and upload progress counts real bytes; other phases show elapsed
time. Cancellation aborts safe transfer steps and waits for critical installation
steps to finish. An interrupted operation re-inspects remote state before retrying.
Health-checked installations are saved and activated through the private connection
manager, which notifies the renderer of the new connection.

## Downloads and activation

The shared release client reads the pinned public manifest and downloads
the server archive without GitHub credentials. Bytes are verified locally,
transferred over SSH and checked again by the installer. The destination is
a validated temporary staging directory.

The installer takes a user-level lock. It validates the archive, version and
existing private configuration before stopping the service. Existing
credentials, state directory and settings remain unless the user explicitly
changes the listener or sandbox mode. New services bind loopback.

Native archives declare their supported `sandboxModes` in `release.json`.
Publication copies this declaration to `serverSandboxModes` in the public
manifest. Planning rejects no-sandbox mode without declared release support;
the installer verifies support again against the downloaded archive.
Under its lock, the installer rechecks the installed mode against the
confirmed plan and checks required isolation before stopping the active
service. It saves the selected mode in the private configuration. Service
startup enforces the saved mode before opening the database. Disabled mode bypasses
the sandbox probe and process sandbox for tools; it retains application
authorization and uses the service account's OS permissions.

An identical healthy package with the same mode and listener is a no-op.
Downgrades are rejected during planning and again under the remote install
lock. Missing installed version metadata fails rather than guessing.

## Transport and data

SSH uses batch mode, strict host-key checking and bounded timeouts.
Agent/X11/local-command forwarding and inherited connection multiplexing
are disabled. Remote scripts and archive bytes use stdin. The helper does
not send local GitHub, model or server credentials to the host.

Desktop privately obtains the configured Intrica service token over the
authenticated SSH connection and keeps it in the connection manager.
Renderer-visible profiles do not contain it. Connection credentials
remain distinct from the public release download channel.

## Failure and recovery

Before activation, the installer saves the previous configuration, service
unit and package pointer in a private recovery directory. Activation failure
stops the candidate and retains data. It does not automatically start an
older binary against a migrated database.

These records are not a database backup. Stop the old execution processes
and back up the complete state directory before upgrading. If SSH fails,
inspect service state and recovery records, then repeat read-only preflight.
The result of a disconnected command does not prove whether activation
completed.

Tests exercise actual installer control flow, archives and files with
isolated system-service fixtures. The UI composition test covers Settings,
the SSH manager, deployment engine, connection storage and authenticated
HTTP. A real Linux host and installed Desktop package require separate
release acceptance.
