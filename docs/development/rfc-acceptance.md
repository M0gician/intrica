# RFC acceptance map

This map covers RFCs #2 through #13, #17 and #18 under #1, and #19–#23 under #16, plus #24. Assertions check observable
results and durable state. Test model responses come from dependency injection
or an isolated compatible HTTP endpoint. Production configuration cannot enable
the built-in test model.

| RFC | Contract and principal checks |
| --- | --- |
| #2 | `file-preview.test.ts` derives file cases from `FILE_PREVIEW_TYPES`, with original-byte checks, Unicode, spaces, absent/wrong extensions, binary, corrupt and large input. `pdf.test.ts` checks immutable snapshots, overwrite/deletion, scope and revocation. `FilePreview`, Markdown, FilesPanel and PDF UI tests cover shared rendering and isolated document images. |
| #3 | `conversation-coordination.test.ts` holds inference open to distinguish queued/read input, transaction consumption and explicit expedite. It checks durable IDs, ordering, repeated requests, cancelled runs and tools. `InputReceipt.test.tsx` checks accessible status and repeat prevention. Browser geometry tests check compact widths for visible text, expansion for timestamps on hover or keyboard focus, and collapse when the pointer leaves, including after a click. Short and multiline messages retain their height, right alignment, lower-right receipts and upper-left expedite overlay. |
| #4 | `model-readiness.test.ts` checks missing configuration, direct requests, Agent overrides, deleted selections and automatic blocking. Model configuration tests reject public Mock selection. Browser and installed-client journeys use a compatible endpoint. |
| #5 | `server-prerequisites.test.mjs`, `install-server.test.mjs`, `deploy-server.test.mjs`, `ssh-operations.test.mjs` cover linger policy/query distinctions, matching versions, changed plans, checksums, progress, cancellation and retained recovery evidence. SSH onboarding E2E exercises the product entry and connection activation. Settings browser checks cover explicit permission selection, inspection retry, four-stage progress, completion, narrow Chinese/English layouts and serious accessibility violations. Selecting permissions alone does not install. |
| #6 | `updates.test.mjs` checks single-action installation, durable state, startup identity/schema checks, caching and duplicate calls. `update-installer.test.mjs` uses temporary installation files for changed targets, replacement, pre-launch recovery and the post-migration rollback barrier. It also checks signature/team decisions and transition target selection. |
| #7 | `download.test.tsx` and `files.test.mjs` check prompt dismissal, later completion, panel lifetime, cancellation, new operations and verified original bytes. |
| #8, #9 | Permission and approval suites check separate file/execution capabilities, legacy intent, real ownership, one-time receipts, delegation, revocation and grant reconciliation. Denied, escalated, expired, changed-target and unknown outcomes remain barriers. |
| #10 | Held-inference coordination tests verify authorized tools start within the controlled two-second target without cancelling inference. Recovery suites check leases, duplicate notifications, original call IDs, dependency order and single consumption. |
| #11 | Tool and command suites exercise equivalent/conflicting cursor modes, extra positioning, permissions, exit codes, signals, timeout and cancellation evidence. A completed process leaves task verification explicit. |
| #12 | `message-stream.test.ts` checks long Unicode streams, duplicates, gaps, snapshot recovery and legacy snapshots. Its fixed 240-chunk sample asserts more than 5x fewer serialized event bytes; this measures local storage, not model fees. Database suites check scoped media, delayed tool delivery, trace IDs, timing, cache accounting and excluded private fields. |
| #13 | The shared Web/Electron matrix uses independent server identities, connection switches, drafts, files, tools and durable approvals. Filesystem, database and HTTP operations remain real. |
| #17 | Collaboration tests cover admin sends across roles, teams and resource scopes; selected/canvas broadcasts; deduplication; self exclusion; unchanged resource grants; resource-reader filtering; frozen audiences; deletion and foreign-target rejection; demotion; zero recipients; completed replay; and promotion resuming the original send. Terminal and escalated approvals remain barriers. Existing inbox tests cover busy/on-demand Agents, missing model configuration and activation limits. |
| #18 | Prompt and tool-contract tests compare read/write/admin/owner instructions and visible parameters, including excluded management operations. Real conversation tests change role and resource access between model turns and recover old checkpoint-only hires under current authority. Name tests cover language fallback, concurrent UI/tool creation, pool exhaustion, rollback, new-field rejection, legacy restore, receipt reuse and human renaming. A controlled Worker scenario reuses an original conversation, recruits an independent member, holds both tasks in flight, exchanges peer evidence and verifies two real file writes with no duplicate hiring, tasks or reports. Shared Web/Electron recruitment uses generated names and actual member IDs. |

| #24 | `sandbox-network.test.ts` runs a real isolated process against a local HTTP server, resolves a hostname, writes the response to its workspace, and checks private, ungranted and read-only file boundaries. It skips when platform isolation or Linux user namespaces are unavailable. A separate macOS probe verified external DNS and certificate-verified HTTPS to PyPI; Linux runtime verification remains pending. |

## Test layers

Continuous-collaboration regression coverage:

| Issue | Contract and principal checks |
| --- | --- |
| #19 | `resource-response.test.ts` covers single and team stop, global and Agent model recovery, restart, a concurrent stop/recovery lock barrier, live-blocked positive controls and future changes after stop. |
| #20 | The content matrix covers summaries on text and PDF resources, text, image descriptions and task state; direct and nested grants, revocation, disabled responses, unchanged values, titles, layout and merged changes share the same delivery checks. |
| #21 | Real database barriers hold a due snapshot or model capture while toggle, stop, revocation, model edits and newer content contend. Revision and lock checks prevent old failures from disabling or postponing new work. Parallel schedulers deliver once. |
| #22 | Below/equal/above-limit cases preserve the automatic budget. Running, message-wait and approval-wait cases follow RunStore admission rules. The feed and UI distinguish queued from consumed, and model, source, queue and activation blocks. Retry is authenticated, revision-checked and idempotent; old notices survive new changes. Browser tests cover retry, refresh and narrow Chinese/English panels. |
| #23 | Independent PostgreSQL connections hold the canvas lock and start transactions in a different order from their writes. Deadlines remain ten seconds after the change and never move backward; title changes preserve the deadline. The test waits for and checks actual single delivery. |

State and recovery rules are documented in [Resource responses](../architecture/resource-responses.md).

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

## Collaboration behavior evidence

The controlled model scenarios exercise the real Worker, model request contents,
tool handlers, inboxes, database transactions, file writes and conversation
checkpoints. They verify context retention, concurrent task execution, member
communication and durable delivery. Decisions come from scripted model replies;
they do not measure how a live model chooses teammates, compares experience or
balances work. Live-model evaluation of these choices remains unverified. Record
context reuse, parallel assignment, proactive communication and delivery
separately, with the model configuration and uncovered scenarios.

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
