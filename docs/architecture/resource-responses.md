# Resource responses

Automatic resource response is enabled by default for new UI/API Agents.
Hired Agents inherit their manager's setting unless explicitly configured;
copies preserve it. The UI names this setting “自动响应资源变化”. A separate
persistent pause controls all automatic collaboration, including inbox and cron
activation. Resource response watches resources an Agent can read.
Text, summaries, image descriptions, task state, resource references and
attachments use the same change detector. Unchanged values, titles and layout
changes do not restart the response timer. An Agent's own changes do not trigger
that same Agent.

Each Agent has one resource-change schedule. Changes merge affected resource IDs
and restart a ten-second stability period, bounded at thirty seconds from the
first pending change so continuous edits cannot postpone delivery indefinitely.
The deadline uses the current
database clock after the canvas lock and content mutation. Time spent waiting
for the lock does not count toward this period. Delivery rechecks resource grants
and includes current authorized resource IDs, revisions and snapshot hashes.

## State and delivery

Schema 13 stores the schedule revision, dispatch state, reason and delivery
references separately from its polling flag.

| Stored state | Meaning | Owner-facing state |
| --- | --- | --- |
| `pending` | A change is waiting for its deadline or an explicit retry. | Pending |
| `blocked` | Model configuration, source availability, activation budget, queue capacity or another dispatch error prevents delivery. | Blocked, with a reason |
| `delivered` | The input and its run reference committed together. | Queued until `messages.consumed_run_id` is set, then consumed |
| `cancelled` | Stop, disabled resource response or a permission reduction invalidated this work. | Cancelled, with a reason |

Consumed means the input entered model context. It does not mean the Agent has
completed its task. The Agent feed includes `resourceResponse`. Changes publish
`conversation.changed` events so open panels can refresh without polling each
schedule. The UI also restores the state after reconnecting.

Failed dispatch rolls back the trigger and run admission to a savepoint. It then
records the block in the same canvas transaction. Queue capacity and transient
errors retry after one minute. Other blocks wait for configuration recovery, an
explicit retry or a new content change. A non-actionable conversation notice
retains each blocked source and reason after a newer change replaces the
schedule. Repeated attempts for the same source and reason reuse that notice.

## Concurrency and cancellation

Dispatch acquires locks in this order:

1. Shared model-configuration advisory lock.
2. Canvas row.
3. Due schedule row, with the observed revision.

It then reads the Agent configuration and captures the model in that transaction.
Global model edits hold the exclusive model lock and acquire affected canvas
locks before updating conversations or schedules. Agent-specific configuration
edits already hold their canvas lock. Success, cancellation and failure updates
cannot apply to a newer schedule revision. A rolled-back transaction leaves the
current work intact; the outer error handler never writes by schedule ID alone.

Pausing an Agent or a team cancels pending and blocked resource responses and
marks delivered but unread resource inputs cancelled. It retains unread
collaboration/user messages, detaches them from cancelled runs and preserves
delivery tracking, consumed receipts, the resource-response setting and cron
settings. Paused Agents admit no automatic message, resource or cron activation.
An explicit user submission or the UI resume action resumes collaboration.
Disabling resource response cancels only undelivered resource responses; it
does not stop an active run. Permission reductions use the same resource
cancellation boundary before the next dispatch.

Model edits recover only live `model_not_configured` blocks whose corresponding
resource-response or cron setting remains enabled. They cannot revive cancelled
responses. A later authorized resource change creates a response only when
resource response is enabled and the Agent is not paused.

## Retry and limits

The owner endpoint is
`POST /api/v2/canvas-agents/:id/resource-response/retry`. It requires the displayed
`expectedRevision` and an `idempotencyKey`. Only a blocked response with resource
response enabled can be retried. Paused Agents cannot dispatch it. The request retains its original source
identity and activation budget. Stale revisions conflict; already delivered or
cancelled inputs cannot be retried. Replayed requests return the original result.

`RunStore.enqueue` applies the existing activation limit. New activations and
resumes from message or approval waits charge the original cause. Input appended
to a running or queued Agent does not add an activation. Retry does not reset
counts or raise the limit: if the cause is still exhausted and a new activation
is needed, the response remains blocked. The owner can send an explicit task to
handle the resources, or retry when the Agent has an active run.

Trigger identity uses the schedule ID and source event, not the retry deadline.
Failed attempts leave no actionable input, and concurrent dispatchers cannot
deliver the same source twice.

## Upgrade and verification

Old disabled records do not establish whether the user stopped them. Migration
retains their source data and requires an explicit retry for legacy model blocks.
Other inactive records become cancelled. Startup and later model edits do not
automatically revive these ambiguous records. When a legacy model block has a
matching delivery receipt, migration preserves the receipt and disables retry.
An unread input already discarded by stop remains cancelled.

`resource-response.test.ts` uses disposable PostgreSQL databases, independent
connections and explicit barriers for snapshot, model and canvas-lock races. It
checks actual trigger delivery after the ten-second deadline, context receipt,
pause and explicit resume, activation counts, queue failures, API idempotency
and migration. `collaboration-lifecycle.test.ts` also checks default settings,
merged resource IDs and the thirty-second delivery bound. Browser tests cover a real Worker flow and both languages in a
narrow panel. Model replies are controlled test inputs; production model quality
and remote deployments are outside these checks.
