# Explicit Agent messages

RFC #26 uses one communication protocol. A model either calls `send_message` or
returns one JSON object as its final text. Both paths call `MessageService`.
Bare text has one correction opportunity. A second invalid output blocks
publication and records the reason. A provider's reasoning content stays in
its execution record. It does not become a delivered message.

```json
{"target":{"kind":"request","id":"request-id"},"kind":"result","message":"Verified findings","fileIds":["published-node-id"]}
{"target":{"kind":"internal"},"message":"An observation to check later"}
```

External messages require `target`, `kind` and `message`. Optional `fileIds`
refer to accessible published snapshots. Admin result messages can include
`handoff: {sourceRunIds, resourceIds?}`. Only those source runs receive handoff
records and resource access. Private notes accept only `target` and `message`.
Text is nonblank and limited to 65,536 characters. Over-limit drafts are retained
as unpublished diagnostics, never silently truncated and delivered.

Targets are request, followup, agent, agents, canvas, resource_readers, manager and
internal. Request targets resolve through stored participants, not the latest
speaker or a default manager. A missing manager fails. Broadcasts exclude the
sender and keep a fixed, deduplicated audience. An empty audience returns zero.

| Message kind | Request effect |
| --- | --- |
| request | Create an open request for every recipient. A question to the original requester creates a child request. |
| update | Keep the addressed request open. |
| result | Mark an addressed request answered after successful delivery. A direct report closes no other request. |
| decline | Mark the specified request declined after successful delivery. It requires a request target. |

The server writes identity, conversation addresses, work associations, logical
IDs and causal links. Model fields cannot override them. User input receives a
request ID too. The composer sends a new question, appends to a selected open
task, or answers a selected question. The user does not enter identifiers.

## Persistence and execution

`message_dispatches` stores a stable logical ID, input hash, generation, source
run, optional tool call, payload, frozen intent and receipt. Tool and final
outputs share validation, permission checks and a canvas transaction. Native
final outputs use dispatch approvals; they do not create synthetic tool calls.
An approval can park one final output while the Agent handles other work.

The transaction validates every address, current authority, request version and
file snapshot, then writes all inbox copies, request transitions and the send
receipt. A replay returns its recorded result. A second formal answer to the
same request fails with the existing reply reference. Different business
messages are not merged by their text.

Each Agent retains one checkpoint. Work items are request metadata, not context
branches. New independent requests queue separately. The selected task's body
enters the next model call. General notices can enter the current context.
Switching tasks retains previous inputs, tools, notes and published replies.
Compaction summarizes the context; request and delivery state remain in tables.

Expedite preserves the input ID and advances the conversation generation. The
runner checks pending expedite requests while acquiring the generation and again
before storing or sending output. Started tools retain their effects and IDs.
Late results keep the work association captured by the original tool call.
Stopped work keeps its reply obligation and an explicit stopped reason; late
business results remain passive. Reset closes the affected obligations. Deletion
marks the conversation as a deleted Agent and its requests unavailable.

Takeover moves the selected task's reply responsibility, pending child return
addresses and request version. It preserves both Agents' checkpoints. User
clarifications still return through their original user conversation and are
forwarded to the current executor. The original executor receives only the
handoff results that name its source run.

## Waits, follow-ups and task lifetime

`wait_for_message({requestIds?,timeoutSeconds?})` persists the work item, run,
generation, inbox boundary and optional deadline. Specific waits accept outgoing
request IDs. An omitted list waits for external input associated with the current
task; a conversation without selected work can wait idle. New independent tasks
remain eligible in the same continuous context.

Message receipt and timeout release the same row under the canvas transaction.
The transition appends one durable server notice, including request receipts,
progress metadata, elapsed time and follow-up counts. A reply already waiting in
the inbox is checked during registration. Maintenance resumes deadlines after
restart. Stop, closed ownership, unknown tool results and upgrade barriers remain
effective. A timeout wakes the waiting Agent only. It sends no reminder and closes
no request. The UI shows targets, deadlines, countdowns and follow-up state, with
wake-now and cancel-wait controls. Cancelling a wait leaves the business request
open and returns the decision to the Agent when its execution barriers permit.

`target:{kind:"followup",id}` with `kind:"update"` routes from the responsible
requester to the existing request's recipient. `target:request` remains the reply
route from recipient to requester. Neither direction guesses from the latest
speaker. Follow-ups reuse the request and context. `INTRICA_MESSAGE_FOLLOWUPS`
defaults to one automatic follow-up per request; each wait window permits at most
one. `INTRICA_MESSAGE_WAIT_MAX_SECONDS` defaults to 86,400 and is bounded to one
week. Timers do not send follow-ups automatically.

Messages accept `priority:normal|expedite`. Owners can expedite pending inputs;
model Agents require current management authority. Agent-originated interruptions
have a 30-second recipient cooldown. User and Agent inputs share delivery,
consumption, elapsed-time and expedite receipts. Consumption means the input was
persisted in model context; it does not imply completion.

New child requests use `lifetime:exclusive` by default. Active parent dependencies
retain them. Closing or stopping one parent releases only its ownership. An
exclusive child closes after its last live owner releases it. Shared children and
`lifetime:independent` requests survive. Pending dispatches close with cancelled
work, while started tools and receipts remain intact. Takeover transfers the task
and its wait deadline to the responsible conversation, with both contexts intact.

## UI and diagnostics

Validated messages show actual receivers, related request state and input
consumption separately. Notes and rejected output are collapsed work records.
Raw `model_output` records and `message.draft` streams are not answer bubbles.
Other Agents' conversation tools exclude private notes and invalid output.

The conversation trace returns message, request, work, dispatch, run, model-call
and tool-call identities. It includes queue/read timing, pending and blocked
counts, rejected duplicate replies and reply latency. Prompts, raw tool
arguments and credentials remain outside the default trace projection. Stage
counts include rejected and observed-but-incomplete calls.

Schema 15 adds model request manifests and optional detailed diagnostics. A
manifest stores context/message hashes, causal input IDs, resource hashes, prompt
and tool versions, adapter/build identifiers and public model options. It also
records the effective provider payload hash when the adapter exposes that hook.
These are observed adapter inputs and causal records, not a claim that a checkpoint
reconstructs an earlier wire request.

Detailed capture is off by default. When enabled, it stores redacted provider
payloads and separate provider argument deltas and parsed arguments. Authentication
credentials and binary payloads are excluded. Default retention is seven days for
detail and 30 days for manifests. Settings provide retention controls and explicit
clearing; the policy revision fences late writes after a clear. The diagnostic
viewer and JSON export include only unexpired content.

OpenAI Chat Completions and Responses adapters request JSON output. Other
provider protocols use the explicit JSON instruction and the same strict
server validation and bounded correction. This boundary is enforced for every
provider; provider-side format support does not replace it.

## Module boundaries

- `collaboration/` owns the contract, target resolution, request state,
  authorization, delivery and receipt projection.
- `work/` owns input admission, inbox scheduling, task selection, context
  construction, checkpoints, model turns, tool-turn draining and completion.
- `execution/` owns leases, generic durable calls, cancellation and recovery.
- `access/` owns permission decisions and grants. It does not schedule inboxes.

Type-only imports can connect interfaces. Runtime imports must remain acyclic.
Execution code cannot import conversation, graph or collaboration handlers.

Schema 14 introduces these records. Migration classifies unread user inputs and
retires pending legacy communication operations. It preserves completed receipts,
checkpoints and history. It does not resend past assistant text, translate old
communication arguments at runtime, or retain a report/reply tool alias.
