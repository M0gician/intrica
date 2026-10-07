<p align="center">
  <img src="apps/desktop/assets/icon.svg" width="88" alt="Intrica logo">
</p>

<h1 align="center">Intrica</h1>
<p align="center">A visual workspace for ideas, sources, and AI agents.</p>
<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

Arrange notes, files, images, PDFs, web pages and tasks on a canvas. Connect
resources, work with a team of agents, and review their requests and results.
Intrica runs on your machine or a server you control.

## Install or run from source

Download published macOS arm64 or Linux x64 installers from
[Releases](https://github.com/M0gician/intrica/releases). Public downloads
and update checks require no GitHub account, token or GitHub CLI.

Desktop includes Node.js, PostgreSQL and the Web interface. Windows,
Intel Mac and Linux arm64 installers are not currently distributed.
macOS builds without Developer ID notarization require explicit approval
in System Settings → Privacy & Security after the first blocked launch.

To run a source checkout, install Node.js 24.18.0 and pnpm 11.20.0:

```sh
pnpm install --frozen-lockfile
pnpm desktop
# Or use the browser:
pnpm web
```

## Start a workspace

1. Create a canvas from the canvas menu.
2. Open Settings → Models. Add your model endpoint and API key, discover
   or add a model, test it, then select it. The built-in mock model makes
   no real model requests.
3. Add and connect resources. Select a node to work with it; double-click
   to open its contents.
4. Give an agent a task. Review requests for additional resource or host
   permissions before approving them.

Agent, workspace and collaboration conversations have right-side history
navigation, previews and bookmarks. Settings include server connections,
shortcut remapping, concurrency limits, run statistics and update controls.
The interface supports English and Chinese.

## Self hosting and updates

Desktop can connect to HTTP(S) servers or use SSH. Settings → Server
connections lists SSH aliases and provides manual host, user and port
entry. Remote deployment requires a supported Linux x64 host, trusted SSH
keys, a systemd user session and working Bubblewrap.

See [self hosting](docs/self-hosting.md) for native services and containers.
Desktop updates do not update remote servers. Public packages are downloaded
with a pinned version and verified before installation. Installation and
remote service changes require explicit user action.

Always back up the database and complete data directory before an upgrade.
See [updates and recovery](docs/updating.md).

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
