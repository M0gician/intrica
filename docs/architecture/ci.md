# CI and releases

Pushes to `main`, release verification and maintainer-dispatched checks
use self-hosted Linux x64 and macOS arm64 runners. Both require the
`self-hosted` and `intrica` labels, plus `Linux` and `X64` or `macOS` and
`ARM64`. Jobs wait when the matching runner is offline. GitHub-hosted
macOS compute is not used.

Pull requests run Linux checks on isolated GitHub-hosted Ubuntu 22.04
runners with read-only permissions and no release secrets. Secret scanning
also runs on hosted Linux. Maintainers must review any selected source ref
before dispatching it to a persistent runner. Actions are pinned to commit
hashes; checkout does not persist credentials.

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

Linux packaging, native-server checks, container publication and published
update acceptance use GitHub-hosted Ubuntu 22.04 runners. macOS packaging
and published-update acceptance use the self-hosted Apple Silicon runner.

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
is verified after merge and before release. Keep the self-hosted runners
online. Their accounts must be dedicated to builds, without personal
credentials or data. Use neutral installation and workspace paths, and
prevent Linux jobs from accessing personal home directories. Require
maintainer review before running contributor workflow changes.

The self-hosted Linux runner uses Ubuntu 22.04 x64. Administrators install
Bubblewrap, libfuse2, Xvfb and Playwright's Chromium system dependencies.
CI installs JavaScript dependencies and browser binaries without sudo.

Configure private vulnerability reporting, immutable releases and public
GHCR visibility before distribution. Making the source
repository public does not itself make the container public. Do not grant
untrusted pull-request code publishing permissions.

Workflow syntax checks and local tests do not establish that hosted jobs,
notarization or public downloads succeeded. Complete those gates before
announcing a release.
