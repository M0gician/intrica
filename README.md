<p align="center">
  <img src="apps/desktop/assets/icon.svg" width="88" alt="Intrica logo">
</p>

<h1 align="center">Intrica</h1>
<p align="center">A visual workspace for ideas, sources, and AI agents.</p>
<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

Arrange notes, files, images, PDFs, web pages and tasks on a canvas. Connect
resources, work with a team of agents, and review their requests and results.
Intrica runs on your machine or a server you control.

## Installation

The current release is [v0.3.1](https://github.com/M0gician/intrica/releases/tag/v0.3.1).
Downloads, update checks and container pulls require no GitHub account,
personal access token or GitHub CLI. Desktop includes Node.js, PostgreSQL
and the Web interface; you do not need to install these separately.

| Platform | Download | Installation |
| --- | --- | --- |
| macOS, Apple Silicon | [DMG](https://github.com/M0gician/intrica/releases/download/v0.3.1/Intrica-0.3.1-mac-arm64.dmg) · [ZIP](https://github.com/M0gician/intrica/releases/download/v0.3.1/Intrica-0.3.1-mac-arm64.zip) | Copy `Intrica.app` to Applications |
| Linux x64, Debian/Ubuntu | [DEB](https://github.com/M0gician/intrica/releases/download/v0.3.1/Intrica-0.3.1-linux-amd64.deb) | Install with `apt` |
| Linux x64, other glibc distributions | [AppImage](https://github.com/M0gician/intrica/releases/download/v0.3.1/Intrica-0.3.1-linux-x86_64.AppImage) | Make executable and run |

Linux release checks run on Ubuntu 22.04 x64. Windows, Intel Mac, Linux
arm64 and Alpine/musl packages are not provided. For a headless Linux x64
host, see [server installation](#server-installation).

### macOS

1. Download the DMG, open it, and drag `Intrica.app` to Applications.
   Alternatively, extract the ZIP and move `Intrica.app` to Applications.
2. Open Intrica from Applications. **v0.3.1 uses an ad-hoc signature and is
   not notarized by Apple.** If macOS blocks it, dismiss the message, open
   **System Settings → Privacy & Security**, choose **Open Anyway**, and
   confirm that you want to open Intrica.
3. If that option is unavailable, check your device's security policy with
   its administrator. Do not disable Gatekeeper globally.

Quit an existing Intrica instance before replacing the app. Back up its
workspace before an upgrade. See [updates and backups](#updates-and-backups).

### Linux

On Debian or Ubuntu, run this in the directory containing the download:

```sh
sudo apt install ./Intrica-0.3.1-linux-amd64.deb
intrica
```

For AppImage, a graphical desktop session is required:

```sh
chmod +x Intrica-0.3.1-linux-x86_64.AppImage
./Intrica-0.3.1-linux-x86_64.AppImage
```

If FUSE 2 is unavailable, use AppImage's extraction mode:

```sh
APPIMAGE_EXTRACT_AND_RUN=1 ./Intrica-0.3.1-linux-x86_64.AppImage
```

Run the desktop app as your regular user. Use the native server or container
on a machine without a graphical desktop.

### Verify a manual download

Download [SHA256SUMS](https://github.com/M0gician/intrica/releases/download/v0.3.1/SHA256SUMS)
from the same release. Calculate your file's SHA-256 and compare it with the
entry for that exact filename. Examples:

```sh
# macOS
shasum -a 256 Intrica-0.3.1-mac-arm64.dmg
# Linux
sha256sum Intrica-0.3.1-linux-amd64.deb
```

Do not install a file whose checksum differs. Download it again from the
release page. Checksums confirm matching bytes; they do not replace trust
in the publisher.

### Optional desktop installer script

With Bash and curl installed, download the version-pinned script:

```sh
curl -q --fail --location --proto '=https' --proto-redir '=https' \
  https://github.com/M0gician/intrica/releases/download/v0.3.1/install.sh \
  -o install.sh
```

Review the downloaded script, quit Intrica, then run:

```sh
bash install.sh v0.3.1
```

The script verifies the package checksum. It installs the app in
`/Applications/Intrica.app` on macOS, uses `apt-get` on Debian/Ubuntu, or
installs an AppImage as `~/.local/bin/intrica` on other Linux x64 systems.
It requests administrator privileges only where the installation needs them.
The macOS first-launch approval still applies.

## Start a workspace

1. Open the app. Local Desktop starts its bundled server automatically;
   no server address or access token is needed. Change the interface
   language in **Settings → General** if needed.
2. Open **Settings → Models**. Add an API endpoint using the base URL
   supplied by your model provider and its API key. Select **No API key**
   only when that endpoint does not require one. Add a model, choose the
   protocol supported by the endpoint, test it, and select it for use.
   Model discovery runs when the model editor opens; you can refresh it or
   enter a model ID manually. The built-in mock model makes no real model
   requests. Provider requests may incur charges.
3. Create a canvas from the canvas menu.
4. Add and connect resources. Select a node to work with it; double-click
   to open its contents.
5. Give an agent a task. Review requests for additional resource or host
   permissions before approving them.

Agent, workspace and collaboration conversations have right-side history
navigation, previews and bookmarks. Settings include server connections,
shortcut remapping, concurrency limits, run statistics and update controls.
The interface supports English and Chinese.

## Server installation

Use a dedicated non-root account on a trusted host. File tools and commands
run on the selected server. An Intrica access token grants owner access;
it is separate from a model API key and from GitHub credentials.

### Native Linux service

The native Linux x64 package includes Node.js, PostgreSQL and the Web client.
The host needs Bash, curl, `tar`, `sha256sum`, `flock`, systemd user services,
and enabled linger. The default tool sandbox also needs working
`/usr/bin/bwrap` with unprivileged namespaces. An administrator must arrange
these prerequisites. For example, on Ubuntu
22.04 the administrator can install `bubblewrap` and `curl`, and run
`sudo loginctl enable-linger SERVER_USER` for the intended service account.
The installer does not change firewall or namespace policy and refuses root.

Log in directly as the service account. Check its session and isolation:

```sh
systemctl --user show-environment
loginctl show-user "$(id -un)" -p Linger --value
/usr/bin/bwrap --unshare-all --die-with-parent --new-session \
  --ro-bind / / --proc /proc --dev /dev /bin/true
```

The linger check must print `yes`; the session check must succeed. The
Bubblewrap check must succeed for sandbox mode. Then download and review
the installer:

```sh
curl -q --fail --location --proto '=https' --proto-redir '=https' \
  https://github.com/M0gician/intrica/releases/download/v0.3.1/install-server.sh \
  -o install-server.sh
```

Run it as the same non-root user, without `sudo`:

```sh
bash install-server.sh v0.3.1
systemctl --user status intrica-server
curl --fail http://127.0.0.1:3001/api/v2/ready
```

If the host cannot create user namespaces, explicitly opt into **no-sandbox
mode** instead of the default installation command:

```sh
bash install-server.sh v0.3.1 --no-sandbox
```

Use a dedicated service account without sudo access or personal credentials.
Application permission checks remain, but shell and MCP commands can use all
files and network resources available to that account. A working directory
does not confine them. No kernel setting is changed. Updates preserve this
choice; `--sandbox` restores the default sandbox after the host passes its
isolation check. See [execution modes](docs/self-hosting.md#explicit-no-sandbox-mode).

New installations listen on `127.0.0.1:3001` and run after logout and reboot.
The configuration and access token are in `~/.config/intrica/server.json`;
the default state directory is `~/.local/share/intrica-server/state`.
Read the `accessToken` privately when connecting manually. Do not publish
the configuration or copy its database password into the connection form.
View service logs with `journalctl --user -u intrica-server -n 80`.

### Deploy or connect over SSH

Desktop can perform the native installation above:

1. Configure SSH key authentication and verify the host key against a
   fingerprint supplied by the server administrator. Intrica uses strict
   host-key checks and non-interactive SSH; load encrypted keys into your
   SSH agent before connecting. SSH password prompts are not supported.
2. Open **Settings → Server connections → Add server**. Choose an alias
   from SSH config, or choose **Add a server manually…** and enter the
   host, non-root username and SSH port.
3. For a new installation, choose **Deploy Intrica… → Check SSH host**,
   enter `v0.3.1`, and choose **Prepare deployment plan**. If needed, select
   **No-sandbox mode** and read its permissions warning before planning.
4. Check the target account, host, version, execution mode and data location. Confirm the
   plan and choose **Deploy and save connection**.
5. Return to the server list and turn on that connection. For a service
   already installed under the same account, use **Add** instead of deploying.

Desktop manages the SSH tunnel and retrieves the service token over SSH.
It does not need a GitHub token. Browser users can create their own tunnel
on the local computer; replace `intrica-host` with their configured SSH alias:

```sh
ssh -N -L 127.0.0.1:3301:127.0.0.1:3001 intrica-host
```

Keep the tunnel running, open `http://127.0.0.1:3301`, and enter the server's
Intrica access token. For an existing HTTPS server, choose the manual
**HTTP / HTTPS** connection in Desktop and supply its address and access
token. Use HTTPS or SSH across untrusted networks. See the
[self-hosting](docs/self-hosting.md) and [SSH deployment](docs/architecture/ssh-server-deployment.md)
guides for operational details.

### Docker Compose

Use a Linux x64 host with Docker Engine and Docker Compose v2. In a new,
persistent deployment directory, download the published Compose file:

```sh
mkdir intrica-deployment
cd intrica-deployment
curl -q --fail --location --proto '=https' --proto-redir '=https' \
  https://github.com/M0gician/intrica/releases/download/v0.3.1/compose.release.yaml \
  -o compose.release.yaml
openssl rand -hex 32
```

Create `.env` in that directory using your editor. Copy the full `serverImage`
value from [intrica-update.json](https://github.com/M0gician/intrica/releases/download/v0.3.1/intrica-update.json)
into `INTRICA_IMAGE`, replacing the digest placeholder below. Replace the
token placeholder with the random value just generated; keep it private:

```ini
INTRICA_IMAGE=ghcr.io/m0gician/intrica@sha256:RELEASE_DIGEST
INTRICA_ACCESS_TOKEN=REPLACE_WITH_YOUR_RANDOM_VALUE
```

**Before starting:** the published file maps `3001:3001` on all host
interfaces. For access on the host or over SSH, edit that mapping to
`127.0.0.1:3001:3001`. For network access, configure HTTPS and restrict
network access before exposing the service.

```sh
chmod 600 .env
docker compose -f compose.release.yaml up -d --wait
docker compose -f compose.release.yaml ps
```

Open `http://127.0.0.1:3001` on the host, or use the SSH tunnel above, and
sign in with `INTRICA_ACCESS_TOKEN`. This image needs no `docker login`.
Keep `.env`, the deployment directory and both volumes (`pgdata` and
`intrica-data`). `docker compose down -v` deletes the workspace volumes.

## Run from source

Install Git, Node.js **24.18.0** and pnpm **11.20.0**, then:

```sh
git clone --branch v0.3.1 --depth 1 https://github.com/M0gician/intrica.git
cd intrica
pnpm install --frozen-lockfile
pnpm --filter @intrica/desktop run prepare:app
pnpm --filter @intrica/desktop exec electron . --user-data-dir="$(pwd)/.data/desktop-dev"
```

These commands use a separate desktop development profile in this checkout.
For a browser-only local workspace, run this after dependency installation:

```sh
HOST=127.0.0.1 pnpm web
```

Open `http://127.0.0.1:3001`; press Ctrl+C to stop the server. `pnpm web`
without `HOST` listens on all interfaces and prints an access-token URL.
Keep that URL private. Browser development stores data in `.data/web` by default.
See the [development guide](docs/development.md) for builds and tests.

## Updates and backups

In Desktop, use **Settings → Version & updates** to download and verify an
update. Stop active work, back up, quit the app, and replace it with the
verified installer. Desktop updates include its bundled server; they do
not update remote servers.

Before upgrading, stop all application writers and back up PostgreSQL and
the complete data directory. For Desktop, quit the app and copy:

- macOS: `~/Library/Application Support/Intrica`
- Linux: `${XDG_CONFIG_HOME:-$HOME/.config}/Intrica`

For a native service, back up its configured state directory and
`~/.config/intrica/server.json`. Use the same service account when applying
a new release. For Compose, preserve `.env`, the project directory and both
volumes; change only the image digest to the selected release, then run:

```sh
docker compose -f compose.release.yaml pull intrica
docker compose -f compose.release.yaml up -d --no-deps --wait intrica
```

Schema 8 and 9 databases migrate to schema 10. Affected conversations pause
for result verification and explicit continuation. Unknown side effects
are not automatically retried. A binary downgrade does not undo database
migration. See [updates and recovery](docs/updating.md) before upgrading.

### Installation problems

- **macOS blocks launch:** follow the approval steps above; verify the
  checksum and download again if the package is damaged.
- **AppImage reports a FUSE error:** use the extraction-mode command above.
- **SSH fails:** check the host key, key authentication, username and port;
  also check the service account's systemd session and linger. If Bubblewrap
  is unavailable, configure it or explicitly select no-sandbox mode.
- **The server asks for a token:** use its Intrica access token. Model API
  keys and GitHub tokens cannot authenticate to Intrica.
- **Downloads time out:** check GitHub/CDN access. See the proxy settings in
  [updates and recovery](docs/updating.md#download-boundaries).

## Data and permissions

Model endpoints receive the context sent to them. Agents use explicit
resource and host permissions. A connected directory can authorize repeated
host commands; a working directory alone does not confine file access.
Without OS isolation, commands run with the server account's privileges.

Intrica uses a shared owner access model for individuals and trusted small
teams. It does not provide separate tenant accounts or private workspaces
between members. Protect server credentials and backups, and use HTTPS or
SSH across untrusted networks. See [security](SECURITY.md).

## Development

- [Development guide](docs/development.md)
- [Contributing](CONTRIBUTING.md)
- [Release notes](CHANGELOG.md)
- [Report a problem](https://github.com/M0gician/intrica/issues)

Do not include credentials, private conversations or workspace exports in
public issues.

## License

[MIT](LICENSE). Third-party components retain their own
[licenses and distribution requirements](docs/development/distribution-licenses.md).
