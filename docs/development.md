# Developing Intrica

Use Node.js 24.18.0 and pnpm 11.20.0. Run `pnpm install --frozen-lockfile`,
then `pnpm desktop` or `pnpm web`. Development instances use separate
data from an installed personal app.

## Layout

- `apps/web`: shared React interface for browsers and Desktop.
- `apps/server`: API, worker, persistence and host/model adapters.
- `apps/desktop`: Electron, connections, SSH and update coordination.
- `packages/contracts`: API schemas and shared application types.
- `packages/client`: HTTP and event transport.
- `packages/releases`: public manifest, version and download contracts.
- `db`: schema and transactional migrations.
- `tests`: database, browser, desktop and installation workflows.

Read the [frontend architecture](architecture/frontend-interactions.md),
[tool contracts](architecture/tool-interface.md) and
[public update architecture](architecture/public-updates.md).

## Validation

Build before tests, and do not rebuild while a suite reads generated
modules:

```sh
pnpm build
pnpm typecheck
pnpm lint
node scripts/ci-tests.mjs functional
node scripts/ci-tests.mjs browser
node --test tests/integration/public-releases.test.mjs
node --test scripts/deploy-server.test.mjs scripts/install-server.test.mjs
pnpm test:matrix
```

The CI test wrapper owns an isolated PostgreSQL cluster, temporary data and
ports. Never point tests at a personal database. Browser tests reset their
dedicated schema. Install Chromium with
`pnpm --filter @intrica/tests-e2e exec playwright install chromium`.

For Desktop, build first, then run the connection/update module tests and
`apps/desktop/test.mjs`, `standalone.test.mjs` and `remote.test.mjs`.
Linux Electron checks need Xvfb. The
[client matrix](development/client-server-test-matrix.md) exercises real
Web and Electron clients against isolated local and remote servers.

Run `node tests/integration/ablate-interactions.mjs` separately. It mutates
generated modules one at a time and restores their bytes. No other test or
build may use that output directory during the experiment.

Prefer business-level tests with real database, HTTP, worker and file
operations. Check permission boundaries, durable outcomes and exactly-once
effects, not just an assistant's final text. New UI tests should use
accessible roles and names that identify the intended control.

## Releases

Desktop and server versions must match. Add release notes under
`docs/releases/v<version>.md` and update the changelog before tagging.
Release CI validates and packages the tag, creates the manifest from the
complete file inventory, verifies uploaded assets in a draft, and only then
publishes it. See [CI](architecture/ci.md).

Consumers use public HTTPS and no GitHub credentials. Publishing uses only
the workflow's short-lived job token. Repository and GHCR visibility must
permit anonymous downloads. Configure immutable releases before publishing.

The manual Update acceptance workflow takes two published versions and
tests replacement with existing data. Both must implement the public
manifest contract. Initial-release validation uses fresh package checks,
schema migration tests and the local public-update HTTP scenarios.

Review [distribution licenses](development/distribution-licenses.md) for
each platform. Developer ID signing and Apple notarization use
`MACOS_CERTIFICATE`, `MACOS_CERTIFICATE_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` in the packaging job.
Incomplete signing credentials fail the build. Without them, the macOS
package uses an ad-hoc signature and requires explicit first-launch approval.

Keep model keys, host identities, logs, database copies, screenshots of
private data and experiment outputs outside version control.
