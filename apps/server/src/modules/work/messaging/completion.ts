import { canvasEvent, type Sql, type Tx } from "../../../adapters/postgres/database.js";
import { appendMessage } from "../../execution/messages.js";
import type { Run } from "../../execution/store.js";
import { reviewStatus } from "./review.js";

export async function completionState(sql: Sql, conversationId: string, runId: string) {
  const status = await reviewStatus(sql, conversationId);
  if (!status.state.deliveries.length)
    return { kind: "ready" as const, fingerprint: status.state.fingerprint };
  if (status.fresh)
    return {
      kind: status.waiting ? ("waiting" as const) : ("ready" as const),
      fingerprint: status.state.fingerprint,
    };
  const count = Number(
    (
      await sql.query(
        `select count(*) as count from messages where conversation_id=$1
    and role='completion_review' and run_id=$2 and content->>'fingerprint'=$3`,
        [conversationId, runId, status.state.fingerprint],
      )
    ).rows[0].count,
  );
  return {
    kind: count >= 2 ? ("blocked" as const) : ("review" as const),
    fingerprint: status.state.fingerprint,
    count,
  };
}

export async function requestCompletionReview(
  tx: Tx,
  run: Run,
  state: Awaited<ReturnType<typeof completionState>>,
) {
  await appendMessage(
    tx,
    run.subject_id,
    `completion-${run.id}-${state.fingerprint}-${state.count ?? 0}`,
    "completion_review",
    {
      hook: "review_inbox",
      fingerprint: state.fingerprint,
      text: '结束前仍有未读的发信或未收到回复的请求。请调用 review_inbox({action:"inspect"})，处理后用 action="confirm" 提交全部 decisions。依赖的回复选 wait；不影响当前任务的发信选 background 并说明 reason。不要重复发送已有消息。',
    },
    run.id,
  );
  await canvasEvent(tx, run.canvas_id, "conversation.changed", { conversationId: run.subject_id });
}
