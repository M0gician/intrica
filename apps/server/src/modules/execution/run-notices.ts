import { canvasEvent, DomainError, type Tx } from "../../adapters/postgres/database.js";
import { appendMessage } from "./messages.js";
import type { Run, RunStore } from "./store.js";

export function failureReason(error: unknown) {
  if (error instanceof DomainError) return error.message;
  const message = error instanceof Error ? error.message : "";
  if (/timeout|timed out|etimedout|\b408\b|\b504\b/i.test(message))
    return "模型请求超时，请检查模型服务后重试";
  if (/\b401\b|\b403\b|authentication|unauthorized|invalid.api.key/i.test(message))
    return "模型服务认证失败，请检查 Endpoint 密钥和权限";
  if (/\b429\b|rate.limit/i.test(message)) return "模型服务限流，请稍后重试";
  if (/fetch failed|econnrefused|econnreset|enotfound|network/i.test(message))
    return "模型服务连接失败，请检查 Endpoint 地址和网络";
  return "运行失败，请检查模型连接或服务日志";
}

/** Publish only server-owned status; private error payloads stay out of team inboxes. */
export async function publishRunNotice(
  tx: Tx,
  runs: Pick<RunStore, "enqueue">,
  run: Run,
  state: string,
  reason: string | null,
) {
  if (run.kind !== "conversation" || !["succeeded", "failed", "waiting"].includes(state)) return;
  const subject = (
    await tx.query(
      `select c.agent_id,n.body->>'title' as title,manager.id as manager_conversation,
       manager.agent_id as manager_id
     from conversations c left join nodes n on n.id=c.agent_id
     left join conversations manager on manager.agent_id=n.parent_id
     where c.id=$1`,
      [run.subject_id],
    )
  ).rows[0];
  if (!subject) return;
  const category = state === "succeeded" ? "complete" : state === "failed" ? "failed" : reason;
  const language =
    (
      await tx.query(
        "select content->>'language' as language from messages where conversation_id=$1 and content ? 'language' order by seq desc limit 1",
        [run.subject_id],
      )
    ).rows[0]?.language ??
    run.frozen_input.language ??
    "en";
  const zh = language === "zh-CN";
  const text =
    category === "unknown"
      ? zh
        ? "工具执行结果未知，需核实后才能继续或接管。"
        : "A tool outcome is unknown. Verify it before continuing or taking over."
      : category === "turn_limit"
        ? zh
          ? "运行已达到回合上限，等待明确的后续指令。"
          : "The run reached its turn limit and needs explicit instructions."
        : category === "failed"
          ? zh
            ? "运行失败，任务尚未完成。"
            : "The run failed. The task is not complete."
          : category === "complete"
            ? zh
              ? "本次运行已结束。"
              : "This run has ended."
            : zh
              ? "运行正在等待后续处理。"
              : "The run is waiting for further input.";
  const content = {
    runId: run.id,
    epoch: run.epoch,
    state,
    category,
    language,
    text,
    subjectId: subject.agent_id,
    subjectName: subject.title ?? "",
    causeId: run.cause_id,
  };
  const key = `run-status-${run.id}-${run.epoch}-${category}`;
  await appendMessage(
    tx,
    run.subject_id,
    key,
    "run_status",
    {
      ...content,
      recipients: subject.manager_id ? [subject.manager_id] : [],
    },
    run.id,
  );
  await canvasEvent(tx, run.canvas_id, "conversation.changed", { conversationId: run.subject_id });
  if (
    !subject.manager_conversation ||
    !["failed", "unknown", "turn_limit"].includes(category ?? "")
  )
    return;
  const prior = await tx.query(
    "select 1 from messages where conversation_id=$1 and client_message_id=$2",
    [subject.manager_conversation, key],
  );
  if (prior.rowCount) return;
  const active = (
    await tx.query(
      "select * from runs where subject_id=$1 and state in('queued','running','waiting') and cancel_requested_at is null",
      [subject.manager_conversation],
    )
  ).rows[0];
  let blocked = false;
  if (active?.state === "waiting" && ["message", "approval"].includes(active.reason)) {
    try {
      await runs.enqueue(tx, {
        canvasId: run.canvas_id,
        subjectId: subject.manager_conversation,
        kind: "conversation",
        frozen: active.frozen_input,
        causeId: run.cause_id,
      });
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "LIMIT_REACHED") throw error;
      blocked = true;
    }
  }
  await appendMessage(
    tx,
    subject.manager_conversation,
    key,
    "team_notice",
    {
      ...content,
      ...(blocked ? { activationBlocked: true } : {}),
    },
    active?.id,
  );
  await canvasEvent(tx, run.canvas_id, "conversation.changed", {
    conversationId: subject.manager_conversation,
  });
}
