import { assertFence, digest } from "../../../adapters/postgres/database.js";
import { closeCheckpointCall, openCheckpointCalls } from "../../execution/checkpoint-tools.js";
import { projectToolOutcome } from "../../execution/messages.js";
import { result } from "../../execution/tool-calls.js";
import type { ExecutionContext } from "../../execution/worker.js";

/** A turn survives run cancellation. Its committed effects must survive with it. */
export async function recoverCheckpointTools(ctx: ExecutionContext) {
  return ctx.store.db.canvas(ctx.run.canvas_id, async (tx) => {
    await assertFence(tx, ctx.run.id, ctx.run.epoch);
    const conversation = (
      await tx.query("select * from conversations where id=$1 for update", [ctx.run.subject_id])
    ).rows[0];
    if (!conversation) return { conversation, blocked: false };
    const turn = conversation.context?.pendingTurnId;
    const checkpoint = conversation.checkpoint;
    const lastAssistant = checkpoint.findLastIndex((m: any) => m.role === "assistant");
    let changed = false,
      blocked = false;
    // Reverse indices so inserting a receipt does not move earlier calls.
    for (const entry of openCheckpointCalls(checkpoint).reverse()) {
      if (!turn || entry.index !== lastAssistant) continue;
      const calls = (
        await tx.query(
          `select t.* from tool_calls t join runs r on r.id=t.run_id
          where r.subject_id=$1 and t.logical_call_id=$2 order by t.created_at desc for update of t`,
          [ctx.run.subject_id, `${turn}:${entry.id}`],
        )
      ).rows;
      const call = calls.find(
        (c) => c.name === entry.name && c.args_hash === digest(entry.arguments),
      );
      if (!call) continue;
      if (call.run_id !== ctx.run.id && ["prepared", "waiting"].includes(call.state)) {
        call.state = "failed";
        call.result = {
          ...result({
            executed: false,
            error: {
              code: "CALL_CANCELLED",
              message: "原运行已结束，此调用尚未执行；根据当前任务决定是否提交新调用。",
            },
          }),
          isError: true,
        };
        await tx.query(
          "update tool_calls set state='failed',result=$2,updated_at=now() where id=$1",
          [call.id, JSON.stringify(call.result)],
        );
        await projectToolOutcome(tx, call.id);
      }
      if (
        call.state === "unknown" ||
        (call.run_id !== ctx.run.id && call.state === "dispatching" && call.effect_class !== "read")
      ) {
        await tx.query("update tool_calls set state='unknown',updated_at=now() where id=$1", [
          call.id,
        ]);
        blocked = true;
        continue;
      }
      if (!["succeeded", "failed"].includes(call.state) || !call.result) continue;
      closeCheckpointCall(checkpoint, entry, call.result, call.id, call.state === "failed");
      changed = true;
    }
    if (changed)
      await tx.query("update conversations set checkpoint=$2 where id=$1", [
        conversation.id,
        JSON.stringify(checkpoint),
      ]);
    return { conversation, blocked };
  });
}
