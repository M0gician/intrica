# Public release updates

Consumers check and download public releases without a GitHub account,
personal token or GitHub CLI. Publishing uses the workflow's short-lived
job token. Model API keys and Intrica server credentials are separate.

## Release contract

Discovery reads this fixed address:

```text
https://github.com/M0gician/intrica/releases/latest/download/intrica-update.json
```

The format 2 manifest contains a stable version, publication timestamp,
API/schema versions, immutable container digest and the complete supported
file inventory. Each file has a controlled name, bounded size and SHA-256.
Desktop DMG/ZIP, DEB, AppImage, native server archive, installer scripts and
Compose metadata are required. One inventory produces both the manifest and
`SHA256SUMS`.

Discovery binds the manifest to its redirected release tag. Downloads use
`/releases/download/v<VERSION>/<FILE>`, never a moving latest URL.
Unsupported or incomplete metadata fails explicitly.

## Responsibilities

- `packages/releases`: strict manifest parsing, stable versions, fixed HTTPS
  transport, streamed downloads and file verification. Its version export is
  browser-safe; network/file exports are Node-only.
- `apps/desktop/updates.mjs`: application-scoped update state, scheduling,
  preferences, cancellation, verified cache reuse and durable install state.
- `apps/desktop/update-installer.mjs` and `update-helper.mjs`: platform identity
  checks, detached replacement, preserved recovery files and explicit profile restart.
- `apps/desktop/update-transition.mjs`: signed macOS DMG transition before
  the normal instance lock or database startup.
- `apps/server/src/http/updates.ts`: authenticated, read-only version/check
  endpoints with a short check cache and shared in-flight request.
- `scripts/deploy-server.mjs`: public archive download plus confirmed SSH
  deployment. Desktop bundles the release package beside this helper.
- `scripts/install*.sh`: standalone public bootstrap downloads and checksums.
- `scripts/release-manifest.mjs` and `publish-release.mjs`: complete inventory,
  draft upload, local/remote byte verification and final publication.

There is one release channel and one updater state owner. Checks do not
install software, stop Agents or change remote servers. Installation and
service updates require explicit action.

## Safety

Node transport sends no Authorization or Cookie header. HTTPS redirects are
bounded and restricted to the fixed release path and GitHub asset CDN hosts.
Metadata is bounded to 64 KiB; artifact size is bounded. Partial files use
exclusive names and are committed only after hash/length verification.
Cached installers are checked again before installation; symlinks are rejected.

The shell installers disable curl configuration files, use fixed version
URLs and bounded HTTPS redirects, and verify checksums before installation.
SSH deployment verifies both sides of the transfer and rechecks the confirmed
host and digest before applying it. See [SSH deployment](ssh-server-deployment.md).

GitHub HTTPS and release controls establish publisher trust. Checksums
detect changed bytes, not a compromised publisher. Enable immutable releases;
publish corrections as new versions. macOS publication requires Developer ID signing and notarization credentials.
The release workflow verifies both the DMG application and update ZIP. Local
development packaging can use ad-hoc signing, but cannot pass trusted update checks.

## Publication and validation

Release CI builds complete packages and verifies the uploaded draft before
publication. Only publishing jobs receive write permissions. Public
repository and GHCR package visibility must be configured by the owner.

The public-release integration tests use real HTTP and files for discovery,
hostile redirects, changed latest versions, corruption, cancellation,
restart-cache reuse and installer handoff. Desktop tests cover replacement,
changed targets, launch failure, the migration boundary, profile restoration,
backoff, notices and concurrent actions. The opt-in Update acceptance workflow
starts from a disposable installed copy, invokes the product update action and
attaches to the replacement process. It never copies the replacement or launches
it on behalf of the updater.

Initial publication does not have a previous public build. Fresh package
checks and database migration tests cover that case. Live anonymous GitHub
downloads, hosted CI, signing and real Linux deployment remain release
acceptance checks; local fixtures cannot establish those outcomes.
