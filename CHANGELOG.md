# Changelog

## 0.5.4

- Preserve complete previous summaries and archive compaction sources for authorized search and progressive reading with `read_context` and the bilingual Working materials panel.
- Keep current message obligations and successful reading positions in durable records; use `read_next` for continuation and expose reopening positions for expired cursors.
- Replace summary-format heuristics and identical retries with a shared text contract, precise diagnostics and one bounded correction whose budget survives restarts.
- Preserve checkpoints and tool receipts when compaction fails, pause automatic inference, and require explicit continuation after uncertain external effects have been verified.
- Simplify source preparation and query validation, remove redundant fallback paths and simulated tests, and retain production regressions and fault-injection checks.
- Upgrade to database schema 18 and tool schema 7. Seal unstarted old-protocol calls for replanning while retaining completed receipts and unknown-outcome barriers.

See [release notes](docs/releases/v0.5.4.md), [upgrade safety](docs/updating.md) and the [experiment report](docs/experiments/context-compression-2026-10-15.md).

## 0.5.3

- Keep assistant tool calls and their results together when compacting context, including oversized final tool groups.
- Reject empty summary sources and carry the previous valid summary into the next summary's evidence.
- Validate context reduction and the complete input budget before atomically saving a checkpoint, summary, memory and compaction count; preserve the original state on failure or cancellation.
- Retain specific summary/budget errors and distinguish the three-attempt summary validation limit from an expired retry window.
- Database schema 17 and tool schema 6 are unchanged.

See [release notes](docs/releases/v0.5.3.md).

## 0.5.1

- Include the ripgrep platform binary in desktop packages so file searches work without a separately installed `rg`.
- Require real Agent file searches in desktop and native-server package acceptance, and cover exported Go method searches.
- Restore remote server upgrades after a desktop client update by excluding installation records from older client releases.
- Recheck the remote service when opening the installation panel and after installation; report success only when its health and running version match.
- Show the inspected current version and an explicit English/Chinese upgrade action.
- Cover client-version changes and stale completion records in SSH and browser regression tests.
- Correct upgrade documentation to database schema 17 and tool schema 6; neither schema changes from 0.5.0.

See [release notes](docs/releases/v0.5.1.md) and [upgrade safety](docs/updating.md).

## 0.5.0

- Preserve original instructions separately from structured context summaries and reject stale compaction results.
- Review remaining work, message obligations and delivery evidence before waiting or ending a conversation.
- Replace the inbox/wait handshake with `read_inbox`, `review_progress` and flat message decisions.
- Coordinate model requests through durable shared quotas, fair admission, bounded retries and endpoint cooldowns.
- Stream large UTF-8 files through scoped persistent cursors and correct multi-page PDF read positions.
- Report tool state, phase and effects explicitly, with updated English and Chinese prompts and UI.
- Stabilize CI approval recovery and browser cleanup; pin checked commits and install Chromium before sandbox tests.
- Database schema 17 and tool schema 6; obsolete unstarted calls are sealed for replanning, while completed receipts and unknown-outcome barriers are retained.

See [release notes](docs/releases/v0.5.0.md) and [upgrade safety](docs/updating.md).

## 0.4.0

- Durable collaboration messages with read/reply reminders, explicit inbox review, prioritization and pause/resume controls.
- Snapshot-scoped permissions, bounded approval recovery, atomic resource delegation and verified artifact copies into Agent workspaces.
- Recovery of committed tool receipts across runs; member removal preserves unfinished handoffs without stopping its manager.
- Clear completion versus waiting instructions, accurate tool failures and live model response progress.
- Read/unread/priority icons, contextual Agent identity, hover timestamps and complete English/Chinese tool labels.
- Unified file previews and downloads, draggable artifact previews, sandbox networking and browser runtime improvements.
- Matching SSH server installation with progress and verified desktop update replacement.
- Database schema 16 and tool schema 5; see the release notes before upgrading.

See [release notes](docs/releases/v0.4.0.md) and [upgrade safety](docs/updating.md).

## 0.3.1

- Explicit no-sandbox mode for native server installation and SSH deployment.
- Persisted execution mode, startup enforcement and plan confirmation checks.
- Server connection details distinguish enabled, disabled and unavailable sandboxes.
- Release capability validation before downloading a no-sandbox deployment.
- English and Chinese installation instructions for both execution modes.

See [release notes](docs/releases/v0.3.1.md) and [self hosting](docs/self-hosting.md).

## 0.3.0

- Visual workspaces with connected notes, files, images, PDFs and web sources.
- Agent teams with explicit permissions, durable tool receipts and result review.
- Shared Web/Electron settings, model discovery, editable shortcuts and SSH connections.
- Right-side message navigation for Agent, workspace and collaboration history.
- Public release checks, installer downloads and SSH deployment without GitHub personal tokens.
- Complete release manifests, verified draft publication and isolated CI runners.
- MIT source license.

See [release notes](docs/releases/v0.3.0.md), [self hosting](docs/self-hosting.md)
and [upgrade safety](docs/updating.md).
