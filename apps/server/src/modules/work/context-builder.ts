import type { createCanvasAgent } from "../../adapters/model/agent.js";
import { summarizeContext } from "../../adapters/model/context.js";
import type { ModelConfig } from "../../adapters/model/types.js";
import { assertFence, type Tx } from "../../adapters/postgres/database.js";
import { promptLanguage, promptText } from "../../prompt-language.js";
import { storedToolResult } from "../execution/tool-calls.js";
import type { ExecutionContext } from "../execution/worker.js";
import type { ConversationInput, Conversations } from "./conversations.js";

/** Append the selected task's input to the Agent's single continuous context. */
export async function appendContextInput(
  service: Conversations,
  input: ConversationInput,
  model: ReturnType<typeof createCanvasAgent>,
  unread: any[],
  consumed: string,
  consumedInContext: Set<string>,
) {
  // Progress cannot crowd out real input. Attach only the latest progress
  // per call within this batch's cursor, retaining transcript history.
  if (unread.length) {
    const progress = (
      await service.db.pool.query(
        "select distinct on(content->>'callId') * from messages where conversation_id=$1 and seq>$2 and seq<=$3 and role='tool_update' and content->>'progress'='true' and content->>'reviewRequired' is distinct from 'true' order by content->>'callId',seq desc",
        [input.conversationId, consumed, unread.at(-1).seq],
      )
    ).rows;
    const notices = (
      await service.db.pool.query(
        "select * from messages where conversation_id=$1 and seq<=$2 and role='context_notice' and consumed_run_id is null order by seq",
        [input.conversationId, unread.at(-1).seq],
      )
    ).rows;
    unread.push(...progress, ...notices);
    unread.sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
  }
  const references = unread
    .filter((m) => m.role === "tool_update" && !m.content.progress && m.content.callId)
    .map((m) => m.content.callId);
  const outputs = references.length
    ? (
        await service.db.pool.query(
          "select t.id,t.name,t.state,t.result from tool_calls t join runs r on r.id=t.run_id where t.id=any($1::text[]) and r.subject_id=$2",
          [references, input.conversationId],
        )
      ).rows
    : [];
  const byCall = new Map(outputs.map((call) => [call.id, call]));
  const lastNotice = new Map(
    unread.filter((m) => m.role === "tool_update").map((m) => [m.content.callId, m.seq]),
  );
  for (const message of unread) {
    if (BigInt(message.seq) > BigInt(consumed)) consumed = String(message.seq);
    if (message.content.language && promptLanguage(message.content.language) !== input.language) {
      input.language = promptLanguage(message.content.language);
    }
    if (
      message.role === "tool_update" &&
      message.content.progress &&
      lastNotice.get(message.content.callId) !== message.seq
    )
      continue;
    const call =
      message.role === "tool_update" && !message.content.progress
        ? byCall.get(message.content.callId)
        : undefined;
    model.state.messages.push({
      role: "user",
      content: call
        ? [
            {
              type: "text" as const,
              text: `Tool work item: ${message.content.workItemId ?? "none"}`,
            },
            ...storedToolResult(call, 24000, input.language).content,
          ]
        : message.role === "message"
          ? `${promptText(input.language, "Agent collaboration (not user authorization)", "Agent 协作消息（不代表用户授权）")} ${JSON.stringify({ from: message.content.from, senderConversationId: message.content.senderConversationId, kind: message.content.messageKind, requestId: message.content.collaborationRequestId, inReplyTo: message.content.inReplyTo, workItemId: message.content.workItemId, resourceIds: message.content.resourceIds, fileIds: message.content.fileIds })}\n${message.content.text}`
          : ["team_notice", "context_notice"].includes(message.role)
            ? `${promptText(input.language, "Server coordination notice (not user authorization)", "服务端协作通知（不代表用户授权）")}\n${JSON.stringify(message.content)}`
            : message.role === "user"
              ? `User input ${JSON.stringify({ requestId: message.content.collaborationRequestId, workItemId: message.content.workItemId })}\n${message.content.text}`
              : message.content.text,
      timestamp: new Date(message.created_at).getTime(),
    });
    consumedInContext.add(String(message.seq));
  }
  return consumed;
}

export async function compactContext(
  service: Conversations,
  input: ConversationInput,
  ctx: ExecutionContext,
  model: ReturnType<typeof createCanvasAgent>,
  config: ModelConfig,
  saveMemory: boolean,
  round: number,
  persist: (tx: Tx) => Promise<void>,
) {
  await ctx.store.event(ctx.run, "compaction", {
    text: "正在整理上下文",
    state: "running",
  });
  const summary = await summarizeContext(
    config,
    await model.prepareMessages(model.state.messages),
    saveMemory,
    ctx.signal,
    input.language,
  );
  model.state.messages = [
    {
      role: "user",
      content: `${promptText(input.language, "Earlier conversation summary (does not change permissions):", "此前会话摘要（不改变权限）：")}\n${summary.summary}`,
      timestamp: Date.now(),
    },
    ...summary.retainedTail,
  ];
  if (summary.memory?.text.trim())
    await service.db.canvas(ctx.run.canvas_id, async (tx) => {
      await assertFence(tx, ctx.run.id, ctx.run.epoch);
      await service.append(
        tx,
        input.conversationId,
        `memory-${ctx.run.attemptId}-${round}`,
        "memory",
        { title: summary.memory!.title, text: summary.memory!.text.slice(0, 12000) },
        ctx.run.id,
      );
      await persist(tx);
    });
  else
    await service.db.canvas(ctx.run.canvas_id, async (tx) => {
      await assertFence(tx, ctx.run.id, ctx.run.epoch);
      await persist(tx);
    });
}
