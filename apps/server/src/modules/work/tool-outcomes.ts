import { canvasEvent, DomainError, id } from "../../adapters/postgres/database.js";
import {
  closeCheckpointCall,
  matchCheckpointCall,
  openCheckpointCalls,
} from "../execution/checkpoint-tools.js";
import { appendMessage, projectToolOutcome } from "../execution/messages.js";
import { result } from "../execution/tool-calls.js";
import type { Conversations } from "./conversations.js";

function pendingEntry(call: any, checkpoint: any[], context: any) {
  const open = openCheckpointCalls(checkpoint);
  const last = checkpoint.map((m) => m.role).lastIndexOf("assistant");
  const candidates = open.filter((entry) =>
    matchCheckpointCall(entry, [call], context?.pendingTurnId, last),
  );
  const current = candidates.find(
    (entry) =>
      entry.index === last && call.logical_call_id === `${context?.pendingTurnId}:${entry.id}`,
  );
  return current ?? (candidates.length === 1 ? candidates[0] : undefined);
}

export function canRetryUnknown(call: any, checkpoint: any[], context: any) {
  return (
    call.result?.details?.interruption !== "tool_contract_upgrade" &&
    call.is_current &&
    (["waiting", "cancelled"].includes(call.run_state) ||
      (call.is_async && call.run_state === "running")) &&
    (call.is_async || Boolean(pendingEntry(call, checkpoint, context)))
  );
}

export async function resolveToolOutcome(
  conversations: Pick<Conversations, "db" | "runs">,
  callId: string,
  decision: "done" | "abandon" | "retry",
  note: string,
) {
  const { db, runs } = conversations;
  const initial = (
    await db.pool.query(
      "select r.canvas_id from tool_calls t join runs r on r.id=t.run_id where t.id=$1",
      [callId],
    )
  ).rows[0];
  if (!initial) throw new DomainError("NOT_FOUND", "工具调用不存在");
  return db.canvas(initial.canvas_id, async (tx) => {
    const call = (
      await tx.query(
        `select t.*,r.subject_id,r.state as run_state,r.frozen_input,
       r.id=(select id from runs where subject_id=r.subject_id order by created_at desc,id desc limit 1) as is_current
       from tool_calls t join runs r on r.id=t.run_id where t.id=$1 for update of t,r`,
        [callId],
      )
    ).rows[0];
    if (call.state !== "unknown") throw new DomainError("INVALID_STATE", "此调用无需核实");
    if (call.run_state === "running" && !call.is_async)
      throw new DomainError("INVALID_STATE", "运行正在保存，请稍后处理");
    const c = (
      await tx.query("select checkpoint,context from conversations where id=$1 for update", [
        call.subject_id,
      ])
    ).rows[0];
    if (!c) throw new DomainError("NOT_FOUND", "原会话不存在");
    if (decision === "retry" && !canRetryUnknown(call, c.checkpoint, c.context))
      throw new DomainError(
        "INVALID_STATE",
        "此调用不能直接重放。请核实结果，继续后使用当前接口提交新请求。",
      );
    const output = {
      isError: decision !== "done",
      content: [
        ...(Array.isArray(call.result?.content) ? call.result.content : []),
        ...result({
          decision,
          note,
          confirmedBy: "user",
        }).content,
      ],
      details: { ...call.result?.details, resolution: { decision, note } },
    };
    await tx.query("update tool_calls set state=$2,result=$3,updated_at=now() where id=$1", [
      callId,
      decision === "done" ? "succeeded" : "failed",
      JSON.stringify(output),
    ]);
    const linked = c.checkpoint.find(
      (m: any) => m.role === "toolResult" && m.intricaCallId === callId,
    );
    const entry = pendingEntry(call, c.checkpoint, c.context);
    if (linked && !call.primary_response)
      Object.assign(linked, { content: output.content, isError: output.isError });
    else if (entry && decision !== "retry") {
      closeCheckpointCall(c.checkpoint, entry, output, callId, output.isError);
      await tx.query(
        "update tool_calls set primary_response=coalesce(primary_response,$2) where id=$1",
        [callId, JSON.stringify(c.checkpoint[entry.index + 1])],
      );
    }
    if (decision === "retry" && !call.is_async)
      c.context = { ...c.context, pendingTurnId: id("turn") };
    if (linked || entry)
      await tx.query("update conversations set checkpoint=$2,context=$3 where id=$1", [
        call.subject_id,
        JSON.stringify(c.checkpoint),
        JSON.stringify(c.context),
      ]);
    await appendMessage(
      tx,
      call.subject_id,
      `resolved-${callId}`,
      "tool_update",
      {
        callId,
        workItemId: call.work_item_id,
        name: call.name,
        status: decision === "done" ? "succeeded" : "failed",
        resolution: note,
        progress: false,
        text: `用户已核实工具结果（${decision}）：${note}`,
      },
      call.run_id,
    );
    await tx.query("update tool_calls set delivered_at=now() where id=$1", [callId]);
    await projectToolOutcome(tx, callId);
    await runs.eventTx(tx, call.run_id, call.attempt_id, "tool.resolved", {
      callId,
      decision,
      note,
    });
    if (decision === "retry") {
      const run =
        call.run_state === "running"
          ? await runs.get(call.run_id, tx)
          : await runs.enqueue(tx, {
              canvasId: initial.canvas_id,
              subjectId: call.subject_id,
              kind: "conversation",
              frozen: call.frozen_input,
              userInitiated: true,
            });
      if (call.is_async)
        await tx.query(
          `insert into tool_calls(id,run_id,attempt_id,logical_call_id,name,args,args_hash,effect_class,state,is_async)
         values($1,$2,$3,$4,$5,$6,$7,$8,'prepared',true)`,
          [
            id("tool"),
            run.id,
            call.attempt_id,
            id("retry"),
            call.name,
            JSON.stringify(call.args),
            call.args_hash,
            call.effect_class,
          ],
        );
    }
    await canvasEvent(tx, initial.canvas_id, "conversation.changed", {
      conversationId: call.subject_id,
    });
    return { resolved: true };
  });
}
