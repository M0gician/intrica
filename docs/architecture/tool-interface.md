# Tool contracts

The registry defines 28 tools. Each model request receives the subset and
parameter schemas that match its current capabilities. Workspace sessions use
the owner's authority. Model visibility is a discovery decision; every
execution checks its current authority and run lease.

| Domain | Tools |
| --- | --- |
| Content and execution | `read`, `write`, `edit`, `rg`, `bash` |
| External capabilities | `web_search`, `mcp`, `list_capabilities` |
| Canvas | `read_canvas`, `create_artifact`, `copy_artifact`, `update_node` |
| Collaboration | `send_message`, `review_inbox`, `update_message`, `list_agents`, `read_conversation`, `get_agent_status`, `get_tool_result`, `wait_for_message` |
| Team | `hire_agent`, `configure_agent`, `dismiss_agent`, `take_over_run` |
| Permissions | `request_permission`, `list_access_requests`, `review_access_request`, `grant_resources` |

The system prompt, visible tools and their descriptions use one capability
snapshot: identity, role, management scope, effective resource grants and
execution authority. The snapshot refreshes before each model request, after
input consumption and context compaction, including recovery. Persona states
personality and responsibilities; it does not change permissions.
Server-authored Chinese and English conversation prompts use affirmative
declarative sentences, including the closing report instruction. User-authored
persona text remains unchanged.

Read/write members do not see hiring, dismissal, resource delegation, approval decisions or run
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

Node reads use the immutable snapshot. `sourcePath` identifies its mutable
origin, which can have different bytes and requires its own filesystem grant.
Image metadata includes the content hash, dimensions and animation timing;
GIF frames are read by zero-based `frame` against that same snapshot. Text mode
exposes metadata even when the model has no image capability.

`copy_artifact({nodeId,expectedRevision,fileName?})` copies authorized immutable
bytes into the caller's own workspace. It checks the node revision, snapshot hash
and byte length, then returns the destination path and receipt. A fixed helper
uses an inode-checked working directory and exclusive, no-follow file creation.
It can reuse identical bytes; it never overwrites a different file or follows a
destination symlink. The copy checks authority under the canvas lock and does not
grant access to the source path. Interrupted writes retain unknown-outcome safeguards.

`grant_resources({agentId,resources:[{nodeId,expectedRevision,mode}]})` delegates a
batch atomically. Administrators need both management authority over the recipient
and the resource mode being delegated. Workspace owners may grant resources to
canvas members. Agent private spaces cannot be delegated this way. Stronger existing
grants are preserved, and this operation grants no new command execution authority.
After success, `send_message` sends the task and references. Snapshot access is by
node identity; source paths always have separate authority.

Saving an artifact does not submit a report or certify task completion.
Command results retain raw exit code, signal, timeout, cancellation and start
failure. Task outcome remains unverified until separately checked. Nonzero
exit codes and SIGPIPE are not silently converted to success.

## Collaboration and permissions

`send_message` uses flat structured arguments. `report_result` is retired and has
no execution alias. Tool schema version 5 is persisted in each new receipt.
Completed historical receipts retain their original result and argument digest.

```json
{"to":"agent","id":"member-id","message":"Please verify the result","expectReply":true,"readWithinSeconds":60,"replyWithinSeconds":120}
{"to":"reply","id":"received-delivery-id","kind":"result","message":"Verified result","fileIds":["snapshot-node-id"]}
{"to":"manager","kind":"result","message":"Independent progress report"}
{"to":"user","kind":"result","message":"Root Agent delivery"}
```

`to` is `agent`/`id`, `agents`/`ids`, `team`, `canvas`, `manager`, `user`,
`reply`/`id`, or `resource_readers`/`ids`. `kind` defaults to `message`;
`result` saves a report and supports authorized handoff resources. A root
Agent has no `manager`, and uses `user` for its final delivery. A tracked
reply copies the incoming `replyTo` address to close exactly that delivery.
`fileIds` identifies accessible published snapshots; `handoffResourceIds` is
restricted to authorized manager results for taken-over work.
The former public `send_message.resourceIds` field has no alias. The `ids` field
of `to:resource_readers` still selects resource readers and grants no access.

`list_agents` exposes the current administrator's team and manager, including
members with different file grants. They communicate without approval.
Membership never grants private conversation, file, host or node access.
Explicit contacts outside that team retain communication authorization checks;
canvas broadcasts require administrator or owner authority. Resource-reader
broadcasts still intersect all specified resource grants. Recipients are frozen
and revalidated before any write. Duplicate recipient IDs are deduplicated.

Every Agent delivery, including an informational message and a new hire's initial
task, has a durable `deliveryId`, read receipt and `replyTo` address. Send receipts
return `deliveries`. Initial tasks expect a reply; `send_message.expectReply`
defaults to false. `readWithinSeconds` defaults to 60 and `replyWithinSeconds`
defaults to 120; each accepts 1–604800 seconds. A reply deadline requires
`expectReply:true`. HTTP `traceId` is diagnostic metadata and is never a reply ID.

Unread and expected-reply deadlines are independent. Maintenance groups due
deliveries by sender and original activation cause in each bounded batch, emits
one `message_notice` with a `deliveries` array, and coalesces simultaneous
conditions. Durable flags suppress repeats of the same condition and version.
Consumed or superseded notices stop being actionable. Notices can wake completed
or message-waiting senders and steer active inference; dispatched tools retain
their existing call IDs. Pause, approval, activation budgets, unknown outcomes
and deleted contexts remain execution barriers.

`update_message({deliveryId,action,waitSeconds?,version?})` supports `wait`,
`expedite` and `cancel`. Waiting postpones reminders, preserving the original
deadlines. Expediting adds a priority follow-up linked to the original delivery,
checks current communication authority and has a recipient-wide 30 second
cooldown. Cancelling stops tracking while preserving read status and permitting
a late reply. Pausing an Agent preserves its inbox and tracking. Direct run
cancellation cancels the sender's open deliveries.
Expediting interrupts active model inference. The tool description asks the sender
to assess response activity and dependencies before interrupting a long generation.
Version conflicts return the current receipt, version and available actions.

Before `wait_for_message`, call `review_inbox({action:"inspect"})` and follow
`nextAfter` for all `items`. Reply to required incoming requests using `replyTo`,
then inspect again. Confirm with:

```json
{"action":"confirm","reviewId":"review-id","decisions":[{"itemId":"message:message-id","action":"handled"},{"itemId":"delivery:delivery-id","action":"background","reason":"This informational update does not block the current task"}]}
```

Each item lists its `allowedActions`. Messages require `handled`; outstanding
incoming requests require a reply or `wait`; outgoing deliveries accept `wait`
or `background` with a reason. Removed-recipient deliveries and member-removal
notices require a reason explaining handling, reassignment or cancellation.
Complete coverage produces `reviewToken` and an explicit completion/next-action
branch. `completion:waiting` permits `wait_for_message({confirmed:true,reviewToken})`;
`completion:ready` directs the model to verify deliverables, submit its final result
and finish. Without a current dependency, prospective waiting requires `reason`
describing an explicitly assigned monitoring task. Missing fields, unknown IDs,
duplicate decisions, incomplete coverage and stale inspections return corrective
errors. New messages, read receipts, replies, notices and delivery changes
invalidate confirmation. These tools are sequential.

Natural completion uses the same review when collaboration obligations remain.
An up-to-date `background` disposition permits completion; `wait` keeps the run
waiting for messages. Missing or stale review adds a durable `completion_review`
hook. Two ignored hooks for the same snapshot pause at `inbox_review`, avoiding
an inference loop. Conversations without pending deliveries or unreviewed removal
notices finish normally. Removing a member does not complete its unfinished work;
its name and outstanding delivery IDs remain in a durable `member_removed` notice.
Normal inbox admission enforces pause and activation limits when waking senders.
The final decision is rechecked under the run fence in the canvas transaction.
The server verifies coverage and state; the model judges the adequacy of its
answers and whether a pending reply blocks the task.

Argument failures persist a failed receipt before dispatch and return
`{error:{code,message,issues?,nextAction?},executed:false}`. Schema issues identify
field paths, expected types and received types without echoing message bodies.
Preflight failures roll back the canvas transaction. Failures after dispatch
retain execution evidence and existing unknown-outcome safeguards. Models
correct the indicated field instead of repeating an ambiguous operation.
Known no-effect rejections retain `executed:false` even when the executor entered
the handler. A JSON string in `read.target` returns a structured-object example.

`request_permission({scope,reason})` uses one scope:

- `{kind:"role",role}`
- `{kind:"resource",nodeId,mode:"read"|"write"}`
- `{kind:"path",path,access:"file",mode:"read"|"write",execution:"none"}`
- `{kind:"path",path,access:"directory",mode:"read"|"write",execution:"none"|"isolated"|"host"}`

New file and directory connections grant file access only. Execution is a
separate capability. Host execution runs under the service account and does
not imply a process filesystem boundary at `cwd`. The tool schema admits only
valid access/execution combinations. Diagnostics select the relevant typed
branch while retaining outer constraints, so models see the incorrect field
instead of errors from unrelated branches. Persistent requests remain distinct
from one-time approval of a frozen call.

Isolated commands use the host network by default, including DNS and HTTPS.
macOS permits network traffic and the DNS/certificate services; Linux shares the
host network namespace and mounts resolver configuration and public certificates
read-only. Filesystem grants and protected paths remain enforced. Package
downloads and network clients can use this mode without `fullHost:true`.

Grant reconciliation can mark a pending, unexecuted request `satisfied` with
no fabricated approver. Equivalent pending persistent requests return the original request ID instead of creating duplicates. Stale reviews return the current status and instruct the model to inspect the current version; only pending requests accept a decision. Denial, expiration, escalation, changed targets and
unknown outcomes remain barriers. Scratch ownership uses the same physical
path rules for both one-time and persistent requests.
A completed approval whose execution conditions are no longer satisfied terminates
the original call with `AUTHORIZATION_CHANGED`; background retries cannot recreate
approvals for that call. Persistent raw-path grants use separate non-snapshot nodes.

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

On recovery, a pending assistant turn matches durable receipts across runs of the
same conversation by turn ID, provider call ID, tool name and argument hash.
Completed receipts repair the checkpoint instead of repeating their effects.
Unstarted calls from ended runs return a no-effect cancellation; uncertain effects
block recovery for verification. A later intentional turn has a distinct identity.
Removing an Agent cancels that Agent's run. Losing management access to an Agent
does not cancel its manager. Actual resource revocation still interrupts affected
execution and preserves unread inputs for later handling.

`get_agent_status` includes the latest model call's phase, request start, first and
last response times, elapsed duration and response age. Stream observations are
throttled to five-second intervals (phase transitions flush immediately), with a
final flush on completion or interruption. These are transport observations, not
proof of semantic progress. Actively streaming requests have no new short timeout.

## Configuration and execution

`hire_agent({persona,task,role,respondToResources?,resourceIds?,inheritResources?})`
creates the member, grants selected resources and submits its first task in one
canvas transaction. Agent callers cannot grant admin; workspace owners specify
resourceIds instead of inheritance. The server randomly selects a name from the
shared language pool, excludes existing canvas names and adds numeric suffixes
when the pool is exhausted. Chinese languages use the Chinese pool; all others
fall back to English. UI creation uses the same server transaction and rules.
New UI/API Agents respond to resource changes by default. Omitted
`respondToResources` inherits the manager's setting, defaulting to true;
copies retain the source setting. The first task has a tracked delivery so its
manager can review, wait for or expedite the expected result.

New hire calls reject `title`, `name`, `displayName` and other unknown fields.
The saved node ID and name are returned on replay; the first task is not submitted
again. Old durable calls and version-1 conversation checkpoints remove only the
obsolete title before validation. The original argument digest is preserved.
New assistant turns persist tool schema version 5. Completed receipts keep their
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

The stored `AgentConfig.enabled` field represents resource-change response.
The separate persisted `agent_configs.paused` flag blocks automatic message,
resource and cron activation. Pausing retains unread collaboration inputs and
their tracking; an explicit user submission resumes collaboration. Unknown
outcomes and upgrade pauses still require their own resolution. Unchanged
schedule configuration preserves its next due time.

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

Schema 15 stores delivery lifecycle, inbox decisions and Agent pause state.
Runtime discovery
reports the actual bundled Node interpreter (including Electron's Node mode)
and readable Chromium distributions. Agent workspaces have a `node` command
shim and private HOME, TMPDIR and XDG cache/config locations. Python discovery
resolves the executable behind the macOS system launcher; workspace shims avoid
the launcher's protected xcrun cache writes. `PYTHONPATH` and `PYTHONUSERBASE`
target per-workspace dependencies. Capabilities report the selected interpreter,
workspace Pillow directory presence and an explicit install command.

Browser capabilities include a discovered executable, fresh profile path and
launch arguments. Disabling Chromium's nested sandbox is recommended only
inside available OS isolation. Animation guidance uses a persistent CDP session
and elapsed-time frame comparisons. macOS grants
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
