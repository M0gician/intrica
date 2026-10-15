# Developing Intrica

Use Node.js 24.18.0 and pnpm 11.20.0. Run `pnpm install --frozen-lockfile`.
For an isolated desktop development profile, run from the repository root:

```sh
pnpm --filter @intrica/desktop run prepare:app
pnpm --filter @intrica/desktop exec electron . --user-data-dir="$(pwd)/.data/desktop-dev"
```

For a local browser workspace, use `HOST=127.0.0.1 pnpm web` and open
`http://127.0.0.1:3001`. Its default data directory is `.data/web`.
Plain `pnpm desktop` uses Electron's default profile; use an explicit
`--user-data-dir` when working separately from an installed app. Do not
run two instances against one data directory.

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

`pnpm test` builds once, then runs isolated functional/database tests, public
update tests, browser tests and Desktop tests in sequence. The individual suites below assume a
completed build. Do not rebuild while a suite reads generated modules:

```sh
pnpm build
pnpm typecheck
pnpm lint
node scripts/ci-tests.mjs functional
node scripts/ci-tests.mjs browser
pnpm test:browser-fixtures
node --test tests/integration/public-releases.test.mjs
node --test scripts/deploy-server.test.mjs scripts/install-server.test.mjs scripts/service-sandbox.test.mjs
pnpm test:matrix
```

The CI test wrapper owns an isolated PostgreSQL cluster, temporary data and
ports. Never point tests at a personal database. Browser tests reset their
dedicated schema. Install Chromium with
`pnpm --filter @intrica/tests-e2e exec playwright install chromium`.

For Desktop, build first; `pnpm --filter @intrica/desktop test` uses the existing
build. To select checks, run the connection/update module tests and
`apps/desktop/test.mjs`, `standalone.test.mjs` and `remote.test.mjs`.
Linux Electron checks need Xvfb. The
[client matrix](development/client-server-test-matrix.md) exercises real
Web and Electron clients against isolated local and remote servers.

Run `node tests/integration/ablate-interactions.mjs` separately. It mutates
generated modules one at a time and restores their bytes. No other test or
build may use that output directory during the experiment.

The safety runner delegates to `node scripts/ci-tests.mjs ablation`, which
owns one temporary PostgreSQL cluster for the whole experiment. Large-data
timing and historical visual comparisons are separate, opt-in runs:

```sh
node scripts/ci-tests.mjs benchmark
node scripts/ci-tests.mjs visual
```

See the [cleanup audit](development/cleanup-audit-2026-10-15.md) for retained
compatibility checks, fixed historical schemas and query-count validation.

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
The repository variable `MACOS_SIGNING_MODE` defaults to `adhoc`: no Apple
credentials may be configured, certificate discovery is disabled and the package
requires manual installation and first-launch approval. Set it to `trusted` only
with all five secrets configured; partial credentials fail the build. Trusted mode
requires notarization and Gatekeeper acceptance. Both modes verify the resource
seal and exercise installed DMG/ZIP applications.

Keep model keys, host identities, logs, database copies, screenshots of
private data and experiment outputs outside version control.
