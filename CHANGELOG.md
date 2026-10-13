# Changelog

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
