import { assertFence, canvasEvent } from "../../adapters/postgres/database.js";
import type { ExecutionContext } from "../execution/worker.js";

/** Context commits and checkpoints share a transaction; recovery never promotes a draft. */
export async function recoverInference(ctx: ExecutionContext) {
  await ctx.store.db.canvas(ctx.run.canvas_id, async (tx) => {
    await assertFence(tx, ctx.run.id, ctx.run.epoch);
    const rows = (
      await tx.query(
        `update inference_attempts a set state='sealed',outcome='interrupted',sealed_at=clock_timestamp()
      from inference_requests q where q.id=a.request_id and q.conversation_id=$1 and a.state<>'sealed' returning a.id`,
        [ctx.run.subject_id],
      )
    ).rows;
    await tx.query(
      "update inference_requests set state='sealed',reason='recovered',sealed_at=clock_timestamp() where conversation_id=$1 and state<>'sealed'",
      [ctx.run.subject_id],
    );
    if (!rows.length) return;
    const discarded = (
      await tx.query(
        "update inference_items set state='discarded',version=version+1,updated_at=now() where attempt_id=any($1::text[]) and state in('streaming','closed') returning id,version",
        [rows.map((r) => r.id)],
      )
    ).rows;
    for (const row of discarded)
      await tx.query(
        "update messages set content=content||jsonb_build_object('state','discarded','version',$3::int) where conversation_id=$1 and client_message_id=$2",
        [ctx.run.subject_id, `inference-item-${row.id}`, row.version],
      );
    await canvasEvent(tx, ctx.run.canvas_id, "conversation.changed", {
      conversationId: ctx.run.subject_id,
    });
  });
}
