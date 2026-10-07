# Self hosting

Use a dedicated account on a trusted host. Intrica grants owner access to
anyone who has the server's access token; it is not a multi-tenant service.
Use HTTPS or an SSH tunnel across untrusted networks.

## Native Linux service

The native package includes Node.js, PostgreSQL and the Web interface.
It supports Linux x64 with a systemd user session, enabled linger, and
working `/usr/bin/bwrap` with unprivileged namespaces. An administrator
must arrange these prerequisites. The installer runs as a non-root user
and does not change firewall, sudo or namespace policy.

Replace `vX.Y.Z` below with a published stable version:

```sh
curl -q --fail --location --proto '=https' --proto-redir '=https' \
  https://github.com/M0gician/intrica/releases/download/vX.Y.Z/install-server.sh \
  -o install-server.sh
bash install-server.sh vX.Y.Z
```

Review the downloaded script before running it. The installer verifies
the selected archive before stopping an existing service. It preserves
credentials, custom settings and the state directory. New services bind
to loopback. `--port` and `--bind` explicitly change the listener.

Alternatively use Settings → Server connections → Add server in Desktop.
Select an SSH alias or enter a host, user and port. Inspect the host, choose
a pinned release and confirm the deployment plan. SSH host keys must
already be trusted. No GitHub CLI or GitHub token is needed locally or on
the remote host. See [SSH deployment](architecture/ssh-server-deployment.md).

Service status and logs:

```sh
systemctl --user status intrica-server
journalctl --user -u intrica-server
```

The private configuration is `~/.config/intrica/server.json`. Retrieve
the Intrica access token privately; the installer does not print it.

## Containers

Download `compose.release.yaml` from the selected public release into
a persistent deployment directory. Create a private `.env` containing:

```ini
INTRICA_IMAGE=ghcr.io/m0gician/intrica-server@sha256:RELEASE_DIGEST
INTRICA_ACCESS_TOKEN=YOUR_RANDOM_PRIVATE_TOKEN
```

Use the exact image digest from `intrica-update.json`. The image package
must be public. Consumer pulls do not require a GitHub login.

```sh
docker compose -f compose.release.yaml up -d --wait
```

Keep the deployment directory, project name, credentials and volumes when
upgrading. The application does not mount a Docker socket or offer a
self-update shell API. Container host access is limited to its configured
mounts and runtime privileges.

## Source services

Install dependencies and run `pnpm web:prepare`. Configure `DATABASE_URL`,
`DATA_DIR`, `INTRICA_ACCESS_TOKEN`, `HOST` and `PORT` before starting
`apps/server/dist/server.js`. Non-loopback listeners require an access token.
Use a service manager and restrict access to configuration and data files.

File tools and terminal commands run on the selected server. A working
directory does not replace OS isolation. Backups must include PostgreSQL
and the complete data directory; see [updates and recovery](updating.md).
