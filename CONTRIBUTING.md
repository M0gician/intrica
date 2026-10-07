# Contributing to Intrica

Use Node.js 24.18.0 and pnpm 11.20.0 for the same toolchain as CI. Start with
the [development guide](docs/development.md) and the
[frontend architecture](docs/architecture/frontend-interactions.md).

## Changes and checks

Keep changes focused. Separate code by responsibility when that makes it
easier to understand and maintain. Validate inputs at the boundary that owns
the rule. Comments should explain constraints or non-obvious decisions.

Build before testing, then run the relevant checks:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
node scripts/ci-tests.mjs functional
node scripts/ci-tests.mjs browser
```

Prefer real database, HTTP, worker and browser tests for behavior changes.
Run safety ablations separately from builds and tests that read generated
modules. Tests must use temporary workspaces, never a personal database or
a production server. Changes to desktop behavior also need Electron checks.

Update documentation to describe the resulting behavior. Keep credentials,
local connection details, private conversations, database backups and raw
incident exports outside Git, including screenshots and test reports.

## Pull requests

Describe the user-visible change, the reason for it, and the checks you ran.
State unverified platforms and installation paths. Use an imperative commit
title near 50 characters and wrap the explanatory body at 72 characters.
Match recent titles; the repository does not use subsystem prefixes.

Fork pull requests run on isolated GitHub-hosted runners. Publication is a
separate maintainer operation. Do not add privileged pull-request workflows
that execute contributor code with release credentials.

## License

Contributions are provided under the [MIT License](LICENSE). Preserve the
license and attribution of any third-party material you include.
