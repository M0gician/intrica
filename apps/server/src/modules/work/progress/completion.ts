import { canvasEvent, type Sql, type Tx } from "../../../adapters/postgres/database.js";
import { appendMessage } from "../../execution/messages.js";
import type { Run } from "../../execution/store.js";
import { progressExecutionState } from "./execution-state.js";
import { mailboxState } from "./mailbox.js";

export async function completionState(sql: Sql, conversationId: string, runId: string) {
  const state = await mailboxState(sql, conversationId);
  const review = (
    await sql.query("select * from progress_reviews where conversation_id=$1 and run_id=$2", [
      conversationId,
      runId,
    ])
  ).rows[0];
  const execution = await progressExecutionState(sql, runId);
  const fresh =
    review?.execution_hash === execution.hash &&
    review?.input_boundary === state.boundary &&
    state.items.every((item) =>
      review.obligations.some((old: any) => old.id === item.id && old.revision === item.revision),
    );
  if (fresh && ["completed", "blocked", "waiting"].includes(review.outcome))
    return {
      kind:
        review.outcome === "completed"
          ? ("ready" as const)
          : review.outcome === "blocked"
            ? ("blocked" as const)
            : ("waiting" as const),
      fingerprint: state.fingerprint,
    };
  const count = Number(
    (
      await sql.query(
        "select count(*) as count from messages where conversation_id=$1 and run_id=$2 and role='completion_review' and content->>'fingerprint'=$3",
        [conversationId, runId, state.fingerprint],
      )
    ).rows[0].count,
  );
  return {
    kind: count >= 2 ? ("stalled" as const) : ("review" as const),
    fingerprint: state.fingerprint,
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
    `progress-${run.id}-${state.fingerprint}-${state.count ?? 0}`,
    "completion_review",
    {
      hook: "review_progress",
      fingerprint: state.fingerprint,
      text: "Review the original requirements, delivery and verification with review_progress({outcome,reason,...}). Use completed only when fulfilled; otherwise continue, waiting with real dependency_ids, or blocked with remaining_work. Inspect pending obligations with read_inbox; do not duplicate deliveries. / 请用 review_progress 对照真实要求、交付和验证作出结论。未完成时继续推进，或说明剩余工作和真实等待依赖、阻碍。按需用 read_inbox 检查待办，不重复发送结果。",
    },
    run.id,
  );
  await canvasEvent(tx, run.canvas_id, "conversation.changed", { conversationId: run.subject_id });
}
