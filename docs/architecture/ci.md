# CI and releases

Linux jobs use isolated GitHub-hosted Ubuntu 22.04 x64 runners. macOS jobs
use a self-hosted Apple Silicon runner with the labels `self-hosted`,
`macOS`, `ARM64` and `intrica`. GitHub-hosted macOS compute is not used.
If the self-hosted runner is offline, macOS jobs wait for it.

Pull requests run Linux checks with read-only permissions and no release
secrets. Pushes to `main`, release verification and maintainer-dispatched
checks also run on macOS. Maintainers must review any selected source ref
before dispatching it to the persistent runner. Actions are pinned to
commit hashes; checkout does not persist credentials.

## Verification

Jobs build before running type checks, lint, functional/database tests,
public-release HTTP/file tests, browser workflows and Electron checks.
Each database test wrapper owns its ports and temporary PostgreSQL cluster.
Generated-code ablations run sequentially with other tests that use dist.
Secret scanning covers fetched history.

The release package is also copied into Desktop's deployment helper bundle,
so it needs no source checkout at runtime. Verify that bundle as part of
installed-package acceptance.

## Publication

A release tag must match Desktop and Server versions and have release notes.
CI verifies fresh installers, native service packages and the container.
The publisher builds one complete inventory, creates a draft release,
compares uploaded sizes and SHA-256 values, and then publishes it as latest.
Existing releases are not overwritten.

Only container publication gets `packages: write`; only release publication
gets `contents: write`. Their `GH_TOKEN` is the ephemeral
`${{ github.token }}`, not a repository secret or personal access token.
Apple signing credentials are scoped to the packaging step.

Consumers and the manual Update acceptance workflow download anonymously.
The acceptance workflow requires two published versions implementing the
public manifest contract. It exercises the prior workspace and pending
approvals through replacement.

## Repository prerequisites

Use the Linux and secret-scan jobs as required pull-request checks; macOS
is verified after merge and before release. Keep the self-hosted macOS
runner online for CI, packaging and published-update acceptance. Its
account must be dedicated to builds, without personal credentials or data.
Require maintainer review before running contributor workflow changes.

Configure private vulnerability reporting, immutable releases and public
GHCR visibility before distribution. Making the source
repository public does not itself make the container public. Do not grant
untrusted pull-request code publishing permissions.

Workflow syntax checks and local tests do not establish that hosted jobs,
notarization or public downloads succeeded. Complete those gates before
announcing a release.
