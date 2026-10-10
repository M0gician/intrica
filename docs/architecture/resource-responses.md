# Resource responses

Continuous collaboration responds to content changes in resources an Agent can
read. Text, summaries, image descriptions, task state, resource references and
attachments use the same change detector. Unchanged values, titles and layout
changes do not restart the response timer. An Agent's own changes do not trigger
that same Agent.

Each Agent has one resource-change schedule. New changes replace its pending
source and start a ten-second stability period. The deadline uses the current
database clock after the canvas lock and content mutation. Time spent waiting
for the lock does not count toward this period.

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

Stopping an Agent or a team cancels pending and blocked resource responses. It
also marks delivered but unread inputs cancelled as the stop discards those
inputs. It preserves consumed receipts, the continuous-collaboration setting and
independent cron settings. Disabling continuous collaboration cancels only
undelivered resource responses; it does not stop an active run. Permission
reductions use the same cancellation boundary before the next dispatch.

Model edits recover only live `model_not_configured` blocks whose corresponding
resource-response or cron setting remains enabled. They cannot revive cancelled
responses. A later authorized resource change can create a new response when
continuous collaboration remains enabled.

## Retry and limits

The owner endpoint is
`POST /api/v2/canvas-agents/:id/resource-response/retry`. It requires the displayed
`expectedRevision` and an `idempotencyKey`. Only a blocked response with continuous
collaboration enabled can be retried. The request retains its original source
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
stop and team-stop recovery, activation counts, queue failures, API idempotency
and migration. Browser tests cover a real Worker flow and both languages in a
narrow panel. Model replies are controlled test inputs; production model quality
and remote deployments are outside these checks.
