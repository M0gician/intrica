# Tool contracts

This page specifies the replacement contract implemented on the runtime redesign
branch: database schema 17 and tool schema 6. The released v0.4.0 uses the earlier contract.
Implementation and verification status are tracked in the
[implementation plan](../development/runtime-reliability-implementation.md).
The confirmed architecture is in [Runtime reliability redesign](runtime-reliability-redesign.md).

The registry defines 28 tools. Each model request receives the subset and
parameter schemas that match its current capabilities. Workspace sessions use
the owner's authority. Model visibility is a discovery decision; every
execution checks its current authority and run lease.

| Domain | Tools |
| --- | --- |
| Content and execution | `read`, `write`, `edit`, `rg`, `bash` |
| External capabilities | `web_search`, `mcp`, `list_capabilities` |
| Canvas | `read_canvas`, `create_artifact`, `copy_artifact`, `update_node` |
| Collaboration | `send_message`, `read_inbox`, `review_progress`, `update_message`, `list_agents`, `read_conversation`, `get_agent_status`, `get_tool_result` |
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

`read` has flat arguments. An initial request selects exactly one of `path`,
`nodeId` and `skillId`; continuation supplies only `cursor`.

```json
{"path":"/workspace/census.json","mode":"text","line":1}
{"nodeId":"published-node-id","page":1}
{"skillId":"/indexed/skill/SKILL.md"}
{"cursor":"read-cursor"}
```

Paths, nodes and skills retain separate authorization. Directories accept auto/text
and return entries; inappropriate line/page/frame/image options fail precisely.
File lines and PDF pages are one-based; image frames are zero-based. Mode and
position are top-level initial parameters, subsequently bound by the cursor.
Text reads stream bounded pages even when the complete UTF-8 file exceeds 1MiB.
A bounded scan toward a distant line returns positioning with a continuation,
not a false EOF. Unicode boundaries and long-line continuations preserve content.
Cursors bind the canvas, conversation, source, version, mode, position and expiry; every page
reauthorizes. Mutable-source changes return SOURCE_CHANGED. Node bytes bind the
published snapshot. No target/cursor compatibility aliases are retained.

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
no execution alias. The replacement tool schema is persisted in each new receipt.
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
or message-waiting senders; active inference receives them at a safe boundary; dispatched tools retain
their existing call IDs. Pause, approval, activation budgets, unknown outcomes
and deleted contexts remain execution barriers.

`update_message` processes one message obligation with flat arguments:

```json
{"delivery_id":"delivery-id","action":"wait","wait_seconds":120,"reason":"The result is still needed"}
{"delivery_id":"delivery-id","action":"background","reason":"This result does not block the current delivery"}
{"delivery_id":"delivery-id","action":"expedite","reason":"This result now blocks delivery"}
{"delivery_id":"delivery-id","action":"cancel","reason":"The work has been reassigned"}
{"message_id":"notice-id","action":"handled","reason":"The removed member's work was reassigned"}
```

Every model action includes a reason. Owner UI actions retain version checks; model actions read current server state. Waiting defers
reminders; cancellation stops tracking but preserves late replies and receipts.
Background records a reason without claiming that the underlying work finished.
Expediting references the original delivery and checks current authority and
recipient cooldown. Only explicit expedite interrupts current inference.

`read_inbox({cursor?})` returns incremental pages with scoped short references and
actual permitted operations. Normal messages keep their persistent consumption
boundary. Resolved read receipts automatically leave the pending set. A reference
cannot be used by another canvas/conversation or after its source becomes invalid.

`review_progress` performs the single final review before waiting or ending:

```json
{"outcome":"continue","reason":"The reviewed slice is delivered","remaining_work":"Read and verify the remaining source files"}
{"outcome":"waiting","reason":"The implementation needs the test result","remaining_work":"Check the result and deliver","dependency_ids":["delivery-id"]}
{"outcome":"completed","reason":"The requested scope is delivered and checked","evidence_refs":["artifact-id","tool-call-id"]}
{"outcome":"blocked","reason":"The required credential is unavailable; reviewed files are saved","remaining_work":"Restore access and finish the remaining review"}
```

outcome and reason are required. Remaining work is required for continue/waiting/
blocked; waiting names existing wake dependencies. Each supplied evidence reference must identify an accessible artifact or a
succeeded call from the conversation. The server checks pending executions; the
model is responsible for deciding whether the evidence fulfills the request. All references
are strings; there are no nested decision arrays and no confirmation token to
pass to a second wait tool. review_inbox and wait_for_message are retired.

The server reads current mailbox/authority/lease state, returns specific unresolved
items if necessary, and persists the review conclusion with its source boundary.
Waiting directly registers the allowed dependencies. Completed permits final
send_message delivery and normal ending; it does not itself send a second result.
Blocked identifies an incomplete objective and needed help. Continue advances the
current work. Partial delivery and receipt acknowledgements do not prove completion.
A user-requested stage can be completed without inventing additional scope.

Only affected decisions are invalidated by new inputs or responsibilities. Reading
or resolving an item shrinks pending work instead of invalidating all prior checks.
Natural completion without a valid review gets a bounded runtime hook. User stop,
cancellation, execution budgets, unknown outcomes and errors retain their own
semantics and cannot be overridden by a review or infinite recovery.
A previously displayed final answer is reused only if no new input or substantive
tool result followed it. A pre-approval waiting reply cannot replace the final
answer after permission is granted.

The runtime retains the actual user and authorized delegation messages separately
from summaries. Only one effective summary enters model context as background;
structured compaction rejects arbitrary prose and out-of-range source references.
Existing native inputs keep their chronological positions; only missing originals
are restored separately. These checks do not prove generated prose is semantically correct. Historical checkpoints remain
available for recovery. No independent task tree or mandatory taskId is introduced.

Tool results expose call.state, call.phase and call.effect in content and details rather than an executed flag. Domain output stays intact; a conflicting domain call field is retained under data. States are
rejected/queued/running/succeeded/failed/unknown; phases are validate/authorize/
dispatch/execute/commit; effects are none/committed/partial/unknown. Durable effects
are not erased by a later error. Unknown effects block automatic replay; partial
effects identify their scope. Errors give precise fields and minimal repairs in
the current language without exposing private arguments or credentials.

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
again. Protocol migration preserves completed receipts and original argument digests.
Unstarted obsolete calls are sealed for replanning, while unknown effects remain
blocked. New assistant turns persist the current tool schema version. Completed receipts keep their
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

Delivery lifecycle, message decisions and Agent pause state are persisted.
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
