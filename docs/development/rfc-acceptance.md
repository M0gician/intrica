# RFC acceptance map

This map covers RFCs #2 through #13 under #1. Assertions check observable
results and durable state. Test model responses come from dependency injection
or an isolated compatible HTTP endpoint. Production configuration cannot enable
the built-in test model.

| RFC | Contract and principal checks |
| --- | --- |
| #2 | `file-preview.test.ts` derives file cases from `FILE_PREVIEW_TYPES`, with original-byte checks, Unicode, spaces, absent/wrong extensions, binary, corrupt and large input. `pdf.test.ts` checks immutable snapshots, overwrite/deletion, scope and revocation. `FilePreview`, Markdown, FilesPanel and PDF UI tests cover shared rendering and isolated document images. |
| #3 | `conversation-coordination.test.ts` holds inference open to distinguish queued/read input, transaction consumption and explicit expedite. It checks durable IDs, ordering, repeated requests, cancelled runs and tools. `InputReceipt.test.tsx` checks accessible status and repeat prevention. Browser geometry tests check multiline bubbles, small icon-only receipts at the lower-right corner, adjacent existing timestamps, and the upper-left hover/keyboard expedite overlay without layout movement. |
| #4 | `model-readiness.test.ts` checks missing configuration, direct requests, Agent overrides, deleted selections and automatic blocking. Model configuration tests reject public Mock selection. Browser and installed-client journeys use a compatible endpoint. |
| #5 | `server-prerequisites.test.mjs`, `install-server.test.mjs`, `deploy-server.test.mjs`, `ssh-operations.test.mjs` cover linger policy/query distinctions, matching versions, changed plans, checksums, progress, cancellation and retained recovery evidence. SSH onboarding E2E exercises the product entry and connection activation. |
| #6 | `updates.test.mjs` checks single-action installation, durable state, startup identity/schema checks, caching and duplicate calls. `update-installer.test.mjs` uses temporary installation files for changed targets, replacement, pre-launch recovery and the post-migration rollback barrier. It also checks signature/team decisions and transition target selection. |
| #7 | `download.test.tsx` and `files.test.mjs` check prompt dismissal, later completion, panel lifetime, cancellation, new operations and verified original bytes. |
| #8, #9 | Permission and approval suites check separate file/execution capabilities, legacy intent, real ownership, one-time receipts, delegation, revocation and grant reconciliation. Denied, escalated, expired, changed-target and unknown outcomes remain barriers. |
| #10 | Held-inference coordination tests verify authorized tools start within the controlled two-second target without cancelling inference. Recovery suites check leases, duplicate notifications, original call IDs, dependency order and single consumption. |
| #11 | Tool and command suites exercise equivalent/conflicting cursor modes, extra positioning, permissions, exit codes, signals, timeout and cancellation evidence. A completed process leaves task verification explicit. |
| #12 | `message-stream.test.ts` checks long Unicode streams, duplicates, gaps, snapshot recovery and legacy snapshots. Its fixed 240-chunk sample asserts more than 5x fewer serialized event bytes; this measures local storage, not model fees. Database suites check scoped media, delayed tool delivery, trace IDs, timing, cache accounting and excluded private fields. |
| #13 | The shared Web/Electron matrix uses independent server identities, connection switches, drafts, files, tools and durable approvals. Filesystem, database and HTTP operations remain real. |

## Test layers

Build once with `pnpm build`. Do not rebuild `dist` while tests use it.

```sh
pnpm typecheck
pnpm lint
node scripts/ci-tests.mjs functional
node scripts/ci-tests.mjs browser
node --test apps/desktop/updates.test.mjs apps/desktop/update-installer.test.mjs
node --test --test-concurrency=1 apps/desktop/test.mjs apps/desktop/standalone.test.mjs apps/desktop/remote.test.mjs
pnpm test:matrix
```

Linux UI tests need Xvfb. Release and SSH tests are listed in the CI workflow.
A fixture passing does not establish platform signing or remote installation.

## Real automatic-update acceptance

Use disposable installed copies and an isolated profile. The product must
perform exit, replacement and restart. The test then attaches to the restarted
process; it cannot launch the replacement or copy application files for it.

Set `INTRICA_UPGRADE_FROM_EXECUTABLE`, `INTRICA_UPGRADE_VERSION` and
`INTRICA_UPGRADE_DISPOSABLE=1`, then run:

```sh
node --test tests/e2e/desktop-upgrade.test.mjs
```

For the macOS legacy path, also set `INTRICA_UPGRADE_TRANSITION_DMG` to the
new signed DMG. Native dialog automation requires accessibility permission.
The test opens the DMG application and presses its install action. It checks
actual versions, schema, original server identity, canvas data, saved browser
storage and pending tool recovery after the product restarts.

The published-update workflow covers macOS ZIP updates and Linux AppImage.
Debian package replacement additionally requires an isolated Linux installation
with a working system permission agent. The unit fixture does not establish
that real package-manager path.

## Conditions that require release equipment

A real signed A-to-B macOS update, the signed legacy transition, real Linux
AppImage/Debian replacement, and first SSH installation on a remote Linux host
remain separate acceptance runs. Record them as unverified when the required
signed artifacts, system privileges or devices are absent. Keep raw logs local;
report platform, artifact identity, checks and results without credentials or
personal workspace paths.
