import { assertFence, type Sql } from "../../adapters/postgres/database.js";
import { actionableMessage } from "../execution/messages.js";
import type { ExecutionContext } from "../execution/worker.js";
import { cutoverInput } from "./input-cutover.js";

/** A coalescing window bounds thinking latency without interrupting on every progress event. */
export function inboxSteerDelayMs() {
  const configured = Number(process.env.INTRICA_INBOX_STEER_MS ?? 2000);
  return Number.isFinite(configured) ? Math.max(250, Math.min(30_000, configured)) : 2000;
}

export function inboxWorkWindowMs() {
  const configured = Number(process.env.INTRICA_INBOX_WORK_WINDOW_MS ?? 5000);
  return Number.isFinite(configured) ? Math.max(1000, Math.min(30_000, configured)) : 5000;
}

export async function steerableInbox(
  sql: Sql,
  conversationId: string,
  delayMs = inboxSteerDelayMs(),
) {
  return (
    await sql.query(
      `select m.client_message_id from messages m join conversations c on c.id=m.conversation_id
    where m.conversation_id=$1 and m.consumed_run_id is null
      and (m.seq>c.consumed_message_seq or m.content->>'workItemId' is not null)
      and ${actionableMessage}
      and m.created_at<=clock_timestamp()-($2::double precision*interval '1 millisecond')
      and not exists(select 1 from messages recent where recent.conversation_id=$1
        and recent.content->>'steeringReason'='inbox'
        and recent.expedite_requested_at>clock_timestamp()-($3::double precision*interval '1 millisecond'))
      and (m.content->>'workItemId' is null or exists(
        select 1 from message_requests q where q.id=m.content->>'workItemId'
          and q.state='open' and q.work_state<>'stopped'
          and not exists(select 1 from message_waits w where w.work_item_id=q.id and w.state='active')))
    order by m.seq limit 1`,
      [conversationId, delayMs, inboxWorkWindowMs()],
    )
  ).rows[0]?.client_message_id as string | undefined;
}

/** Internal scheduling cannot grant authority, restart stopped work or bypass unknown outcomes. */
export async function steerInbox(ctx: ExecutionContext, decisionRevision: number) {
  // Idle inboxes are common across a large team. Avoid taking the canvas lock
  // for every model heartbeat; recheck under the lock before an actual cutover.
  if (!(await steerableInbox(ctx.store.db.pool, ctx.run.subject_id))) return false;
  return ctx.store.db.canvas(ctx.run.canvas_id, async (tx) => {
    await assertFence(tx, ctx.run.id, ctx.run.epoch);
    const c = (
      await tx.query("select generation from conversations where id=$1", [ctx.run.subject_id])
    ).rows[0];
    if (Number(c?.generation) !== decisionRevision) return true;
    const barrier = await ctx.store.conversationBarrier(ctx.run.subject_id, tx);
    if (barrier.paused || barrier.unknown || ctx.signal.aborted) return false;
    const messageId = await steerableInbox(tx, ctx.run.subject_id);
    if (!messageId) return false;
    await cutoverInput(tx, ctx.run.subject_id, messageId, ctx.run.id, false);
    await tx.query(
      'update messages set content=content||\'{"steeringReason":"inbox"}\'::jsonb where conversation_id=$1 and client_message_id=$2',
      [ctx.run.subject_id, messageId],
    );
    return true;
  });
}
