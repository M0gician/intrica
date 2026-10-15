import type { Tx } from "../../../adapters/postgres/database.js";
import { cancelApprovals } from "../../execution/cancellation.js";
import { appendMessage, projectToolOutcome } from "../../execution/messages.js";
import { result } from "../../execution/tool-calls.js";
import { withOutcome } from "../../execution/tool-outcome.js";

/** Called under the run fence after stopping local work; completed receipts are immutable. */
export async function sealContextTools(tx: Tx, runId: string) {
  await cancelApprovals(tx, [runId]);
  const active = (
    await tx.query(
      "select * from tool_calls where run_id=$1 and state in('prepared','waiting','dispatching') for update",
      [runId],
    )
  ).rows;
  for (const call of active) {
    const unknown = call.state === "dispatching" && call.effect_class !== "read";
    const output = withOutcome(
      {
        ...result({
          error: {
            code: unknown ? "TOOL_OUTCOME_UNKNOWN" : "CONTEXT_PAUSED",
            message: unknown
              ? "The tool was interrupted during a context failure. Verify its actual outcome before repeating it. / 上下文故障期间工具被中断，请先核实实际结果再决定重试。"
              : "The read or unstarted operation was stopped after context failure. Replan after continuation. / 上下文故障后已停止读取或尚未派发的操作，请继续后重新规划。",
          },
          ...(call.result ? { interruptedReceipt: call.result } : {}),
        }),
        isError: true,
      },
      {
        callId: call.id,
        state: unknown ? "unknown" : "failed",
        phase: "execute",
        effect: unknown ? "unknown" : "none",
      },
    );
    await tx.query(
      "update tool_calls set state=$2,result=$3,completed_at=now(),updated_at=now(),delivered_at=null where id=$1",
      [call.id, unknown ? "unknown" : "failed", JSON.stringify(output)],
    );
  }
  // Publish final receipts before retiring the run; future contexts can inspect the original call.
  const outcomes = (
    await tx.query(
      "select id,state,name from tool_calls where run_id=$1 and is_async and delivered_at is null and state in('failed','unknown','succeeded')",
      [runId],
    )
  ).rows;
  const conversation = (await tx.query("select subject_id from runs where id=$1", [runId])).rows[0];
  for (const call of outcomes) {
    await projectToolOutcome(tx, call.id);
    await appendMessage(
      tx,
      conversation.subject_id,
      `context-tool-${call.id}-${call.state}`,
      "tool_update",
      {
        callId: call.id,
        status: call.state,
        progress: false,
        text: `Tool ${call.name} (${call.id}): ${call.state}. Inspect its original receipt. / 请检查原始工具回执。`,
      },
      runId,
    );
    await tx.query("update tool_calls set delivered_at=now() where id=$1", [call.id]);
  }
}
