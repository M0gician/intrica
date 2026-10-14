# CI and releases

Linux x64 checks use isolated GitHub-hosted Ubuntu 22.04 runners for pull
requests, `main`, release verification and maintainer-dispatched checks.
This provides the user namespaces required by Bubblewrap without changing
the namespace policy of an existing host. macOS arm64 checks use a dedicated
runner with `self-hosted`, `intrica`, `macOS` and `ARM64` labels. Those jobs
wait when the runner is offline. GitHub-hosted macOS compute is not used.

Pull requests use read-only permissions and no release secrets. Secret scanning
also runs on hosted Linux. Maintainers must review any selected source ref
before dispatching it to a persistent runner. Actions are pinned to commit
hashes; checkout does not persist credentials.
Ordinary CI checks out the event's exact commit (the merge commit for a pull
request), so queued jobs and retries cannot silently pick up a later branch
revision. Explicit verification refs remain available to release callers.

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
Apple signing credentials are scoped to the packaging step. `MACOS_SIGNING_MODE`
defaults to `adhoc`, with no Apple credentials and no certificate discovery. It
verifies resource seals and installed apps, without claiming notarization.
`trusted` mode requires all signing secrets, notarization and Gatekeeper checks.
Release notes must state the chosen mode and manual-install requirements.

Consumers and the manual Update acceptance workflow download anonymously.
The acceptance workflow requires two published versions implementing the
public manifest contract. It exercises the prior workspace and pending
approvals through replacement.

## Repository prerequisites

Use the Linux and secret-scan jobs as required pull-request checks; macOS
is verified after merge and before release. Keep the macOS runner
online. Its account must be dedicated to builds, without personal
credentials or data. Use neutral installation and workspace paths, and
prevent Linux jobs from accessing personal home directories. Require
maintainer review before running contributor workflow changes.

Linux jobs install Bubblewrap, libfuse2, Xvfb and Chromium system dependencies
on the disposable runner. JavaScript dependencies and browser binaries are
installed without sudo. A host with user namespaces disabled cannot run the
sandbox acceptance suite; tests must not bypass isolation to pass that gate.

Configure private vulnerability reporting, immutable releases and public
GHCR visibility before distribution. Making the source
repository public does not itself make the container public. Do not grant
untrusted pull-request code publishing permissions.

Workflow syntax checks and local tests do not establish that hosted jobs,
notarization or public downloads succeeded. Complete those gates before
announcing a release.
