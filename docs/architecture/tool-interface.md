# Tool contracts

The registry defines 26 tools. Each model request receives the subset and
parameter schemas that match its current capabilities. Workspace sessions use
the owner's authority. Model visibility is a discovery decision; every
execution checks its current authority and run lease.

| Domain | Tools |
| --- | --- |
| Content and execution | `read`, `write`, `edit`, `rg`, `bash` |
| External capabilities | `web_search`, `mcp`, `list_capabilities` |
| Canvas | `read_canvas`, `create_artifact`, `update_node` |
| Collaboration | `send_message`, `review_inbox`, `update_message`, `list_agents`, `read_conversation`, `get_agent_status`, `get_tool_result`, `wait_for_message` |
| Team | `hire_agent`, `configure_agent`, `dismiss_agent`, `take_over_run` |
| Permissions | `request_permission`, `list_access_requests`, `review_access_request` |

The system prompt, visible tools and their descriptions use one capability
snapshot: identity, role, management scope, effective resource grants and
execution authority. The snapshot refreshes before each model request, after
input consumption and context compaction, including recovery. Persona states
personality and responsibilities; it does not change permissions.
Server-authored Chinese and English conversation prompts use affirmative
declarative sentences, including the closing report instruction. User-authored
persona text remains unchanged.

Read/write members do not see hiring, dismissal, approval decisions or run
takeover. Their shared tools expose their own schedule, requests and conversation.
Only administrators see takeover. Read members do not see canvas mutation tools.
Host execution grants permit commands under the service account's host privileges.
A connected directory supplies a working-directory reference. Internal tool
definitions remain available for durable recovery and enforce current permissions.

## Reading

`read` accepts one typed target:

```json
{"target":{"kind":"path","path":"/workspace/notes.md"}}
{"target":{"kind":"node","nodeId":"node-id"}}
{"target":{"kind":"skill","skillId":"/indexed/skill/SKILL.md"}}
```

Paths use host authorization; nodes use canvas authorization; skills must
match the installed catalog. Authorization failure stays within the
selected target. A directory returns entries. Text stays text and images
remain image content parts. Canvas results carry node identity and revision.

Continue with the same target and the returned `nextCursor`. Cursors bind
the target and preserve PDF display mode. Each continuation checks current
permissions. Explicit `line` and PDF `page` are one-based; image `frame`
is zero-based. Do not combine explicit positioning with a cursor. An explicit mode is allowed
only when it equals the cursor mode (or the target default when omitted in the
cursor). Conflicting modes fail without changing read permissions.
An empty PDF text layer is not OCR; page images can contain unread evidence.

## Typed mutations

- `create_artifact({kind:"text"|"todo", title, ...})` saves a canvas
  artifact. `path` attaches an existing file to text. `completed` belongs
  to todo. `shareWithManagers:false` creates an author-only grant;
  resource-change subscriptions use those grants to select recipients.
- `update_node({nodeId, expectedRevision, patch})` accepts either
  `{kind:"content", title?, text?, summary?, completed?}` or
  `{kind:"todo_item", itemIndex, completed}`. Checkbox indices are
  zero-based and interpreted against the specified node revision.
- `edit({path, edits:[{oldText,newText}]})` validates unique,
  non-overlapping matches in the same original file and commits once.
  `write` replaces the complete file. Both session types share these
  contracts and the `bash({command,cwd?,timeout?,fullHost?})` contract.

File artifacts persist a content-addressed snapshot. `send_message.fileIds`
accepts their node IDs and checks accessible published snapshots. Text reports
can omit attachments. Clients resolve `intrica-file:NODE_ID` within the owning
server and conversation. Hashes and file references never grant access.

Saving an artifact does not submit a report or certify task completion.
Command results retain raw exit code, signal, timeout, cancellation and start
failure. Task outcome remains unverified until separately checked. Nonzero
exit codes and SIGPIPE are not silently converted to success.

## Collaboration and permissions

`send_message` uses flat structured arguments. `report_result` is retired and has no
execution alias. Tool schema version 3 is persisted in each new receipt; old
completed receipts remain readable, and persisted version 2 sends retain their
original argument hashes when adapted during recovery.

```json
{"to":"agent","id":"member-id","message":"Please verify the result","expectReply":true,"replyWithinSeconds":120}
{"to":"request","id":"received-request-id","kind":"result","message":"Verified result","fileIds":["snapshot-node-id"]}
{"to":"manager","kind":"result","message":"Independent progress report"}
{"to":"user","kind":"result","message":"Root Agent delivery"}
```

`to` is `agent`/`id`, `agents`/`ids`, `team`, `canvas`, `manager`, `user`,
`request`/`id`, or `resource_readers`/`ids`. `kind` defaults to `message`;
`result` saves a report and supports authorized handoff resources. A root
Agent has no `manager`, and uses `user` for its final delivery. A tracked
reply copies the incoming `replyTo` address to close exactly that request.
`fileIds` identifies accessible published snapshots; `resourceIds` is
restricted to authorized manager results for taken-over work.

`list_agents` exposes the current administrator's team and manager, including
members with different file grants. They communicate without approval.
Membership never grants private conversation, file, host or node access.
Explicit contacts outside that team retain communication authorization checks;
canvas broadcasts require administrator or owner authority. Resource-reader
broadcasts still intersect all specified resource grants. Recipients are frozen
and revalidated before any write. Duplicate recipient IDs are deduplicated.

`expectReply` defaults to false. When true, each recipient receives a durable
request and reply address; `replyWithinSeconds` defaults to 120 (range 1 to
604800). A missed deadline emits one `message_notice` for that request version,
with read and run status. It wakes a message-waiting sender and steers active
inference. It never restarts an already dispatched tool. `update_message` takes
`requestId`, `action` (`wait`, `expedite`, `cancel`), optional `waitSeconds` and
`version`. Waiting extends the deadline without sending another message;
expediting sends a follow-up tied to the original request, checks current
communication authority and has a recipient-wide 30 second cooldown. Cancelling
stops reply tracking. Stop cancels the sender's open requests; paused, unknown
and deleted contexts retain their execution barriers.

Before `wait_for_message`, call `review_inbox({})` and follow `nextAfter` for
remaining messages. Reply to outstanding requests, or explicitly track them.
Read the updated mailbox after replying, then submit its `reviewKey`,
`handledMessageIds` and `trackRequestIds`. Only complete coverage produces a
`reviewToken`; unknown IDs fail. Then call
`wait_for_message({confirmed:true,reviewToken})`. New messages, replies, deadline
notices and request changes invalidate the token. These tools are sequential.
The server verifies coverage and state, while the model remains responsible for
judging whether its answers and follow-up decisions are sufficient.

Argument failures persist a failed receipt before dispatch and return
`{error:{code,message,issues?,nextAction?},executed:false}`. Schema issues identify
field paths, expected types and received types without echoing message bodies.
Preflight failures roll back the canvas transaction. Failures after dispatch
retain execution evidence and existing unknown-outcome safeguards. Models
correct the indicated field instead of repeating an ambiguous operation.

`request_permission({scope,reason})` uses one scope:

- `{kind:"role",role}`
- `{kind:"resource",nodeId,mode:"read"|"write"}`
- `{kind:"path",path,access:"file"|"directory",mode:"read"|"write",execution:"none"|"isolated"|"host"}`

New file and directory connections grant file access only. Execution is a
separate capability. Host execution runs under the service account and does
not imply a process filesystem boundary at `cwd`. Legacy
`directory_and_commands` explicitly requests write plus host execution;
migration retains it only when the original grant records that intent.
Persistent requests remain distinct from one-time approval of a frozen call.

Isolated commands use the host network by default, including DNS and HTTPS.
macOS permits network traffic and the DNS/certificate services; Linux shares the
host network namespace and mounts resolver configuration and public certificates
read-only. Filesystem grants and protected paths remain enforced. Package
downloads and network clients can use this mode without `fullHost:true`.

Grant reconciliation can mark a pending, unexecuted request `satisfied` with
no fabricated approver. Equivalent pending persistent requests return the original request ID instead of creating duplicates. Stale reviews return the current status and instruct the model to inspect the current version; only pending requests accept a decision. Denial, expiration, escalation, changed targets and
unknown outcomes remain barriers. Scratch ownership uses the same physical
path rules for both one-time and persistent requests.

## Input receipts and tool recovery

Appending input persists it in queue without cancelling inference. Read
status is recorded atomically with the context checkpoint. A message becomes
read only after that transaction commits. Reconnect reads durable receipts.

An explicit expedite request addresses the existing message ID and cancels
only inference. Earlier unread inputs enter context in order. Started tools
retain their call IDs and state; unstarted tools check new input before dispatch.
Stopped runs and unknown outcomes keep their existing barriers.

The run lease owner listens for committed tool-state notifications during
inference. Bounded polling recovers lost notifications. Dispatch rechecks
permissions, capacity and dependencies and uses the original logical call ID.
Tool approval does not cancel inference or create a second dispatch owner.

## Configuration and execution

`hire_agent({persona,task,role,respondToResources,resourceIds?,inheritResources?})`
creates the member, grants selected resources and submits its first task in one
canvas transaction. Agent callers cannot grant admin; workspace owners specify
resourceIds instead of inheritance. The server randomly selects a name from the
shared language pool, excludes existing canvas names and adds numeric suffixes
when the pool is exhausted. Chinese languages use the Chinese pool; all others
fall back to English. UI creation uses the same server transaction and rules.

New hire calls reject `title`, `name`, `displayName` and other unknown fields.
The saved node ID and name are returned on replay; the first task is not submitted
again. Old durable calls and version-1 conversation checkpoints remove only the
obsolete title before validation. The original argument digest is preserved.
New assistant turns persist tool schema version 2. Completed receipts keep their
historical result. Existing names and human renaming remain supported; Agent
tools cannot rename Agent nodes.

Role-specific prompts encourage early parallel work, continued use of relevant
Agents in their original conversations and peer questions, findings and dependency
updates. Administrators can recruit for large or independent tasks without first
exhausting existing members. Prompt guidance does not guarantee a model's choices.

`configure_agent({agentId?,expectedRevision,patch})` accepts persona,
role, `respondToResources` and schedule fields. Only an Agent targeting
itself may omit `agentId`. An Agent can change its own schedule; mixed
patches still require authority for every field. Schedules use
`{cron,timezone,prompt,enabled}`; `null` clears a schedule.

Resource response, cron activation, message delivery and stopping a run
are independent. The stored `AgentConfig.enabled` field represents
resource-change response. Unchanged schedule configuration preserves its
next due time.

The registry composes domain definitions from `modules/work/tools/`.
Normalization freezes inputs; preflight holds the canvas lock and run
fence; execution uses durable receipts. Visibility refresh and execution
lookup share the same current registry. Approval and wait operations are
sequential. Unknown external outcomes require explicit resolution.

Schema 10 reconciles execution state once, in the schema migration
transaction. A complete persisted receipt is read before current schema
validation or definition lookup, after checking its run/call identity and
argument digest. Only new execution requires a current tool definition.

`RunStore.conversationBarrier` checks upgrade pauses and unknown outcomes
across the conversation. Submission, transactional claim and tool dispatch
use this boundary. An unknown outcome blocks its conversation without
reserving global tool concurrency. A user must resolve all unknown
outcomes and explicitly continue an upgrade pause. Continuation creates a
new run with current configuration and preserves unconsumed messages.

`tool-outcomes.ts` records verification separately from continuation.
Checkpoint results are updated only through a durable call ID or an
unambiguous identity/argument match. Retry eligibility is computed by the
server. See [upgrade instructions](../updating.md) for backup and recovery.

## Verification

The real-database suites exercise atomic edits, strict branches, schedule
independence, private publication, cursor binding, multimedia reads,
approval recovery, frozen audiences, handoffs, schema 8/9 migration,
conversation pauses, receipt reuse and transactional rollback.
Browser and shared Web/Electron tests exercise the same tool receipts.

Run `node scripts/ci-tests.mjs functional` after building. Generated-code
ablation checks run separately with `node tests/integration/ablate-interactions.mjs`.

## Sandbox runtime support

Schema 14 adds message request and inbox review persistence. Runtime discovery
reports the actual bundled Node interpreter (including Electron's Node mode)
and readable Chromium distributions. Agent workspaces have a `node` command
shim and private HOME, TMPDIR and XDG cache/config locations. macOS grants
application distribution reads, executable mappings, same-sandbox process
signals, limited system IPC and Chromium's Mach port rendezvous. Browser profile
and user credential directories remain outside those grants. macOS also denies
Unix socket connections under server-private paths, closing the owner RPC
channel even though public networking is allowed; direct, symlink and hardlink
paths are covered by a real sandbox test. Headless Chromium
with a fresh profile was verified with actual script and WebGL rendering.
Linux mounts discovered browser distributions read-only and creates private
shared memory under `/dev/shm`; its runtime test is conditional on host support.

The maintained reference is [Codex sandboxing](https://developers.openai.com/codex/sandboxing)
and [Codex seatbelt policies at 6e5f665](https://github.com/openai/codex/tree/6e5f665feb9b71e1500a5721036fbdb8e871f4b0/codex-rs/sandboxing/src).
Intrica keeps its existing host-network policy and separate host-execution
approval. It does not inherit Codex's default networking policy or unrestricted
filesystem preferences IPC.
