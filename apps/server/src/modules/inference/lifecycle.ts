import {
  assertFence,
  canvasEvent,
  DomainError,
  id,
  type Tx,
} from "../../adapters/postgres/database.js";
import type { ExecutionContext } from "../execution/worker.js";
import type { ContinuationCapabilities, InferenceIdentity } from "./types.js";

export async function inferenceState(
  ctx: ExecutionContext,
  tx: Tx,
  identity: InferenceIdentity,
  state: string,
  reason?: string,
) {
  await ctx.store.eventTx(tx, identity.runId, ctx.run.attemptId, "inference.request", {
    ...identity,
    state,
    reason,
  });
  await canvasEvent(tx, ctx.run.canvas_id, "conversation.changed", {
    conversationId: identity.conversationId,
  });
}

export async function openAttempt(
  ctx: ExecutionContext,
  identity: Omit<InferenceIdentity, "attemptId" | "contextSeq">,
  capabilities: ContinuationCapabilities,
  manifest: Record<string, unknown>,
) {
  const attemptId = id("inference-attempt");
  let contextSeq = "0";
  await ctx.store.db.canvas(ctx.run.canvas_id, async (tx) => {
    await assertFence(tx, identity.runId, identity.leaseEpoch);
    const c = (
      await tx.query("select generation,context_seq from conversations where id=$1", [
        identity.conversationId,
      ])
    ).rows[0];
    if (Number(c.generation) !== identity.decisionRevision)
      throw new DomainError("EXPEDITED", "输入已更新");
    contextSeq = String(c.context_seq);
    await tx.query(
      "insert into inference_requests(id,conversation_id,run_id,work_item_id,decision_revision) values($1,$2,$3,$4,$5) on conflict(id) do nothing",
      [
        identity.requestId,
        identity.conversationId,
        identity.runId,
        identity.workItemId,
        identity.decisionRevision,
      ],
    );
    await tx.query(
      `insert into inference_attempts(id,request_id,lease_epoch,ordinal,context_seq,capabilities,manifest)
      select $1,$2,$3,coalesce(max(ordinal),0)+1,$4,$5,$6 from inference_attempts where request_id=$2`,
      [
        attemptId,
        identity.requestId,
        identity.leaseEpoch,
        contextSeq,
        JSON.stringify(capabilities),
        JSON.stringify({ ...manifest, contextSeq }),
      ],
    );
    await inferenceState(ctx, tx, { ...identity, attemptId, contextSeq }, "prepared");
  });
  return { ...identity, attemptId, contextSeq };
}

export async function writableAttempt(tx: Tx, identity: InferenceIdentity) {
  await assertFence(tx, identity.runId, identity.leaseEpoch);
  const row = (
    await tx.query(
      "select * from inference_attempts where id=$1 and lease_epoch=$2 and state<>'sealed' and (settle_deadline is null or settle_deadline>=clock_timestamp()) for update",
      [identity.attemptId, identity.leaseEpoch],
    )
  ).rows[0];
  return row;
}

/** Last adapter hook before network dispatch, after payload construction and diagnostic capture. */
export async function claimDispatch(
  ctx: ExecutionContext,
  identity: InferenceIdentity,
  dispatch = true,
) {
  return ctx.store.db.canvas(ctx.run.canvas_id, async (tx) => {
    await assertFence(tx, identity.runId, identity.leaseEpoch);
    const row = (
      await tx.query(
        `select c.generation,a.state from conversations c join inference_requests q on q.conversation_id=c.id
      join inference_attempts a on a.request_id=q.id where a.id=$1`,
        [identity.attemptId],
      )
    ).rows[0];
    if (
      !row ||
      !["prepared", "streaming"].includes(row.state) ||
      Number(row.generation) !== identity.decisionRevision
    )
      throw new DomainError("EXPEDITED", "当前请求已被新的输入取代");
    if (!dispatch) return;
    await tx.query(
      "update inference_attempts set state='streaming',dispatched_at=coalesce(dispatched_at,clock_timestamp()) where id=$1",
      [identity.attemptId],
    );
    await tx.query("update inference_requests set state='streaming' where id=$1", [
      identity.requestId,
    ]);
    await inferenceState(ctx, tx, identity, "streaming");
  });
}

export async function beginSettling(
  ctx: ExecutionContext,
  identity: InferenceIdentity,
  settleMs: number,
) {
  await ctx.store.db.canvas(ctx.run.canvas_id, async (tx) => {
    await assertFence(tx, identity.runId, identity.leaseEpoch);
    await tx.query(
      `update inference_attempts set state='settling',cutover_at=coalesce(cutover_at,clock_timestamp()),
      settle_deadline=coalesce(settle_deadline,clock_timestamp()+$2*interval '1 millisecond') where id=$1 and state<>'sealed'`,
      [identity.attemptId, settleMs],
    );
    await tx.query(
      "update inference_requests set state='settling' where id=$1 and state<>'sealed'",
      [identity.requestId],
    );
    await inferenceState(ctx, tx, identity, "settling");
  });
}

export async function sealRequest(ctx: ExecutionContext, requestId: string) {
  await ctx.store.db.canvas(ctx.run.canvas_id, async (tx) => {
    await assertFence(tx, ctx.run.id, ctx.run.epoch);
    await tx.query(
      "update inference_requests set reason=case when state in('cutting','settling') then 'cutover' else reason end,state='sealed',sealed_at=clock_timestamp() where id=$1 and state<>'sealed'",
      [requestId],
    );
  });
}
