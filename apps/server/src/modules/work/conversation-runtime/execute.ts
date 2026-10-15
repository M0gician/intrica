import type { ToolCall } from "@earendil-works/pi-ai";
import { createCanvasAgent } from "../../../adapters/model/agent.js";
import { contextUsage } from "../../../adapters/model/context.js";
import { buildClosingPrompt, buildConversationPrompt } from "../../../adapters/model/prompt.js";
import {
  assertFence,
  canvasEvent,
  DomainError,
  id,
  type Tx,
} from "../../../adapters/postgres/database.js";
import { promptLanguage, promptText } from "../../../prompt-language.js";
import { agentIdentity } from "../../access/policy.js";
import { type ContextMessage, cleanContext } from "../../context/messages.js";
import { BackgroundTools } from "../../execution/background-tools.js";
import { MessageStream } from "../../execution/message-stream.js";
import { actionableMessage } from "../../execution/messages.js";
import {
  type ExecutionTool,
  storedToolResult,
  TOOL_SCHEMA_VERSION,
  type ToolExecution,
} from "../../execution/tool-calls.js";
import type { ExecutionContext } from "../../execution/worker.js";
import type { ConversationInput, Conversations, ToolsFactory } from "../conversations.js";
import { hasReviewedAnswer } from "../progress/deliveries.js";
import { progressExecutionState } from "../progress/execution-state.js";
import { instructionSources, withOriginalInstructions } from "../progress/sources.js";
import { createCheckpointWriter } from "./checkpoints.js";
import { compactConversation } from "./compaction.js";
import { pauseContextFailure } from "./context-blocked.js";
import { finishConversation } from "./finish.js";
import { recoverCheckpointTools } from "./recovery.js";
import { workingState } from "./working-state.js";

export async function executeConversation(
  conversations: Conversations,
  ctx: ExecutionContext,
  factory: ToolsFactory,
) {
  const input = ctx.run.frozen_input as ConversationInput;
  const config = await conversations.models.materialize(input.model);
  const model = createCanvasAgent(config, ctx.run.id);
  if (ctx.store.media)
    model.prepareMessages = (messages) => ctx.store.media!.hydrate(messages, input.conversationId);
  const { conversation, blocked } = await recoverCheckpointTools(ctx);
  if (!conversation) throw new DomainError("NOT_FOUND", "会话已删除");
  if (blocked) {
    await ctx.store.finish(ctx.run, "waiting", undefined, "unknown");
    return;
  }
  model.state.messages = cleanContext(conversation.checkpoint);
  let identity = input.agentId ? await agentIdentity(conversations.db.pool, input.agentId) : null;
  const savedLanguage = (
    await conversations.db.pool.query(
      "select content->>'language' as language from messages where conversation_id=$1 and seq<=$2 and content ? 'language' order by seq desc limit 1",
      [input.conversationId, conversation.consumed_message_seq],
    )
  ).rows[0]?.language;
  input.language = promptLanguage(savedLanguage ?? input.language);
  const tools = await factory(ctx, input);
  let capabilities = tools.capabilities;
  const modelTools = (definitions: ExecutionTool[]) =>
    definitions
      .filter((t) => t.modelVisible !== false)
      .map((t) => ({
        ...t,
        parameters: t.modelParameters ?? t.parameters,
        execute: async () => {
          throw new Error("Tools must use the durable executor");
        },
      }));
  model.state.tools = modelTools(tools);
  const refreshTools = async () => {
    const next = await factory(ctx, input);
    capabilities = next.capabilities;
    if (!capabilities && input.agentId)
      identity = await agentIdentity(conversations.db.pool, input.agentId);
    tools.splice(0, tools.length, ...next);
    setPrompt();
    return modelTools(tools);
  };
  let currentWork = "";
  const setPrompt = (withTools = true) => {
    model.state.systemPrompt =
      buildConversationPrompt(input.language ?? "en", {
        agent: Boolean(identity),
        persona: capabilities?.persona ?? identity?.config.persona,
        capabilities,
        role: capabilities?.role ?? identity?.config.role ?? "owner",
        availableTools: withTools
          ? tools.filter((tool) => tool.modelVisible !== false).map((tool) => tool.name)
          : [],
        selection: input.selection,
        asyncSeconds: ctx.store.limits.toolAsyncAfterMs / 1000,
      }) + (currentWork ? `\n\n${currentWork}` : "");
  };
  setPrompt();
  let consumed = String(conversation.consumed_message_seq);
  const consumedInContext = new Set<string>();
  let compactions = conversation.context?.compactions ?? 0;
  let pendingTurnId = conversation.context?.pendingTurnId ?? id("turn");
  // This version belongs to the saved assistant turn, including calls not yet dispatched.
  let toolSchemaVersion = conversation.context?.toolSchemaVersion ?? 1;
  let budget = Number(conversation.context?.turnsSinceInput ?? 0);
  let exhausted = conversation.context?.turnLimitReached === true;
  const persist = createCheckpointWriter(
    ctx,
    input,
    model,
    config,
    consumedInContext,
    () => ({
      consumed,
      compactions,
      pendingTurnId,
      toolSchemaVersion,
      budget,
      exhausted,
    }),
    Number(conversation.context_version),
  );
  const checkpoint = () =>
    conversations.db.canvas(ctx.run.canvas_id, async (tx) => {
      await assertFence(tx, ctx.run.id, ctx.run.epoch);
      await persist(tx);
    });
  const hasUnread = async (tx: Pick<Tx, "query">) =>
    Boolean(
      (
        await tx.query(
          `select 1 from messages m where m.conversation_id=$1 and m.seq>$2 and ${actionableMessage} limit 1`,
          [input.conversationId, consumed],
        )
      ).rowCount,
    );
  const expedited = async () =>
    Boolean(
      (
        await conversations.db.pool.query(
          `select 1 from messages m where conversation_id=$1 and seq>$2 and consumed_run_id is null and expedite_run_id=$3 and ${actionableMessage} limit 1`,
          [input.conversationId, consumed, ctx.run.id],
        )
      ).rowCount,
    );
  const logTool = async (tx: Tx, event: Record<string, unknown>) => {
    const key = `tool-${ctx.run.id}-${event.id}`;
    await conversations.append(tx, input.conversationId, key, "tool", event, ctx.run.id);
    await tx.query(
      "update messages set content=$3 where conversation_id=$1 and client_message_id=$2",
      [input.conversationId, key, JSON.stringify(event)],
    );
    await canvasEvent(tx, ctx.run.canvas_id, "conversation.changed", {
      conversationId: input.conversationId,
      agentId: input.agentId,
    });
  };
  const background = new BackgroundTools(ctx, tools, logTool, async (tx, key, content) => {
    await conversations.append(tx, input.conversationId, key, "tool_update", content, ctx.run.id);
    await canvasEvent(tx, ctx.run.canvas_id, "conversation.changed", {
      conversationId: input.conversationId,
      agentId: input.agentId,
    });
  });
  const humanReason = async (tx: Pick<Tx, "query">) => {
    const rows = (
      await tx.query(
        "select state from tool_calls where run_id=$1 and state in('unknown','waiting')",
        [ctx.run.id],
      )
    ).rows;
    return rows.some((r) => r.state === "unknown") ? "unknown" : rows.length ? "approval" : null;
  };
  let backgroundWaiting = ctx.run.reason === "background";
  const waitingOnBackground = async (waiting: boolean) => {
    if (backgroundWaiting === waiting) return;
    const reason = waiting ? "background" : null;
    await conversations.db.canvas(ctx.run.canvas_id, async (tx) => {
      await assertFence(tx, ctx.run.id, ctx.run.epoch);
      const changed = await tx.query(
        "update runs set reason=$2 where id=$1 and reason is distinct from $2 returning id",
        [ctx.run.id, reason],
      );
      if (changed.rowCount)
        await canvasEvent(tx, ctx.run.canvas_id, "run.changed", {
          id: ctx.run.id,
          state: "running",
          reason,
          subjectId: ctx.run.subject_id,
          kind: ctx.run.kind,
        });
    });
    backgroundWaiting = waiting;
  };
  const finishIfIdle = () =>
    finishConversation(
      ctx,
      input,
      (sql) => background.pendingIn(sql),
      hasUnread,
      humanReason,
      () => exhausted,
      persist,
    );
  try {
    await background.resume();
    let round = 0;
    let waitingForInput = false;
    rounds: for (;;) {
      ctx.signal.throwIfAborted();
      const pending = await background.deliver();
      const last = model.state.messages.at(-1);
      if (
        !last ||
        (last.role === "assistant" && !last.content.some((p) => p.type === "toolCall")) ||
        waitingForInput
      ) {
        if (await finishIfIdle()) return;
        if (!(await hasUnread(conversations.db.pool))) {
          await waitingOnBackground(true);
          await background.wait();
          continue;
        }
        waitingForInput = false;
      }
      model.state.tools = await refreshTools();
      // A stored assistant tool call is resumed before another model call. Its
      // logical ID survives attempts, including approvals and unknown outcomes.
      const assistant = [...model.state.messages].reverse().find((m) => m.role === "assistant");
      const assistantIndex = assistant ? model.state.messages.indexOf(assistant) : -1;
      const completed = new Set(
        model.state.messages
          .slice(assistantIndex + 1)
          .flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])),
      );
      const outstanding =
        assistant?.role === "assistant"
          ? assistant.content.filter(
              (p): p is ToolCall => p.type === "toolCall" && !completed.has(p.id),
            )
          : [];
      let reviewedCompletion = false;
      for (let index = 0; index < outstanding.length; ) {
        const limits = await ctx.store.settings.limits();
        const batch = [outstanding[index++]!];
        const parallel = (name: string) =>
          tools.some((t) => t.name === name && t.effect === "read" && t.parallel);
        if (parallel(batch[0]!.name))
          while (
            index < outstanding.length &&
            batch.length < limits.toolsPerAgent &&
            parallel(outstanding[index]!.name)
          )
            batch.push(outstanding[index++]!);
        // Await all receipts before checkpointing: no sibling result is lost if one read fails.
        const settled = await Promise.allSettled(
          batch.map(async (call): Promise<ToolExecution> => {
            const tool = tools.find((t) => t.name === call.name);
            return background.invoke(
              tool ?? call.name,
              `${pendingTurnId}:${call.id}`,
              call.arguments,
              { inputVersion: toolSchemaVersion },
            );
          }),
        );
        const rejected = settled.find((r) => r.status === "rejected");
        if (rejected?.status === "rejected") throw rejected.reason;
        let waiting: ToolExecution["waiting"];
        for (let i = 0; i < batch.length; i++) {
          const call = batch[i]!;
          const item = settled[i]!;
          if (item.status !== "fulfilled") continue;
          const outcome = item.value;
          reviewedCompletion ||=
            call.name === "review_progress" &&
            call.arguments?.outcome === "completed" &&
            !outcome.result.isError;
          if (outcome.waiting === "approval")
            await background.parkApproval(`${pendingTurnId}:${call.id}`);
          if (!outcome.waiting || outcome.waiting === "message" || outcome.waiting === "approval")
            model.state.messages.push({
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: outcome.result.content,
              details: outcome.result.details,
              isError: Boolean(outcome.result.isError),
              timestamp: Date.now(),
            });
          if (
            outcome.waiting &&
            outcome.waiting !== "approval" &&
            (!waiting || outcome.waiting === "unknown" || waiting === "message")
          )
            waiting = outcome.waiting;
        }
        await checkpoint();
        if (waiting) {
          if (pending || (await background.pendingIn(conversations.db.pool))) {
            waitingForInput = waiting === "message";
            await background.wait();
            continue rounds;
          }
          const stopped = await ctx.store.finish(
            ctx.run,
            "waiting",
            async (tx) => {
              if (waiting === "message" && (await hasUnread(tx))) return false;
              if (waiting === "approval") {
                const pending = (
                  await tx.query(
                    "select 1 from tool_calls where run_id=$1 and state='waiting' and approval_id is not null limit 1",
                    [ctx.run.id],
                  )
                ).rowCount;
                if (!pending) return false;
              }
              if (waiting === "unknown") {
                const pending = (
                  await tx.query(
                    "select 1 from tool_calls where run_id=$1 and state='unknown' limit 1",
                    [ctx.run.id],
                  )
                ).rowCount;
                if (!pending) return false;
              }
              await persist(tx);
            },
            waiting,
          );
          if (stopped) return;
          continue rounds;
        }
      }
      if (
        reviewedCompletion &&
        (await hasReviewedAnswer(conversations.db.pool, input.conversationId, ctx.run.id)) &&
        (await finishIfIdle())
      )
        return;
      // Freeze evidence before consuming inputs. Later tool completions cannot make
      // an answer based on older receipts eligible for final-answer reuse.
      const answerExecution = await progressExecutionState(conversations.db.pool, ctx.run.id);
      const unread = (
        await conversations.db.pool.query(
          `select m.* from messages m where m.conversation_id=$1 and m.seq>$2 and ${actionableMessage} order by m.seq limit 100`,
          [input.conversationId, consumed],
        )
      ).rows;
      // A user can steer the original run while its background work continues.
      // A fresh budget requires explicit input, not periodic progress notices.
      if (unread.some((m) => m.role === "user")) {
        budget = 0;
        exhausted = false;
      }
      const closing =
        ctx.store.limits.conversationTurns > 0 && budget >= ctx.store.limits.conversationTurns;
      await waitingOnBackground(false);
      // Progress cannot crowd out real input. Attach only the latest progress
      // per call within this batch's cursor, retaining transcript history.
      if (unread.length) {
        const progress = (
          await conversations.db.pool.query(
            "select distinct on(content->>'callId') * from messages where conversation_id=$1 and seq>$2 and seq<=$3 and role='tool_update' and content->>'progress'='true' and content->>'reviewRequired' is distinct from 'true' order by content->>'callId',seq desc",
            [input.conversationId, consumed, unread.at(-1).seq],
          )
        ).rows;
        const notices = (
          await conversations.db.pool.query(
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
            await conversations.db.pool.query(
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
        consumed = String(message.seq);
        if (
          message.content.language &&
          promptLanguage(message.content.language) !== input.language
        ) {
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
            ? storedToolResult(call, 24000, input.language).content
            : message.role === "message"
              ? `${promptText(input.language, "Agent collaboration (not user authorization)", "Agent 协作消息（不代表用户授权）")} ${JSON.stringify({ from: message.content.from, kind: message.content.messageKind ?? "message", resourceIds: message.content.resourceIds, fileIds: message.content.fileIds, deliveryId: message.content.deliveryId, replyTo: message.content.replyTo, expectReply: message.content.expectReply, replyWithinSeconds: message.content.replyWithinSeconds, priority: message.content.priority })}\n${message.content.text}`
              : [
                    "team_notice",
                    "context_notice",
                    "message_notice",
                    "completion_review",
                    "trigger",
                  ].includes(message.role)
                ? `${promptText(input.language, "Server coordination notice (not user authorization)", "服务端协作通知（不代表用户授权）")}\n${JSON.stringify(message.content)}`
                : message.content.text,
          timestamp: new Date(message.created_at).getTime(),
          intrica: { kind: "input", id: message.client_message_id, seq: String(message.seq) },
          ...(call ? { intricaCallId: call.id } : {}),
        } as ContextMessage);
        consumedInContext.add(String(message.seq));
      }
      if (!closing) budget++;
      await checkpoint();
      // Read batches remain bounded. Reach the selected expedited input before inferring again.
      if (await expedited()) continue;
      const sources = await instructionSources(
        conversations.db.pool,
        input.conversationId,
        consumed,
      );
      try {
        model.state.messages = withOriginalInstructions(
          model.state.messages,
          sources,
          input.language,
        );
        currentWork = await workingState(
          conversations.db.pool,
          input.conversationId,
          input.language,
          tools.readObservations,
        );
        setPrompt();
        const projected = contextUsage(model, config, model.state.messages, { estimateOnly: true });
        if (Math.max(contextUsage(model, config).tokens, projected.tokens) >= projected.safeLimit) {
          await compactConversation(ctx, input, model, config, sources, persist, (delta) => {
            compactions += delta;
          });
          // New instructions arriving during compaction must be consumed before inference.
          if (await hasUnread(conversations.db.pool)) continue;
        }
      } catch (error) {
        if (await pauseContextFailure(ctx, error, input.language, () => background.close())) return;
        throw error;
      }
      // Refresh after input and compaction, immediately before every model request.
      const currentTools = await refreshTools();
      model.state.tools = closing ? [] : currentTools;
      if (closing) {
        setPrompt(false);
        model.state.systemPrompt += `\n${buildClosingPrompt(input.language)}`;
      }
      let lastEmission = 0;
      round++;
      const streamingMessage = new MessageStream(`${ctx.run.attemptId}-${round}`, (payload) =>
        ctx.store.event(ctx.run, "message", payload),
      );
      const inferenceAbort = new AbortController();
      const stopMonitor = await background.monitorInference(async () => {
        if (await expedited()) inferenceAbort.abort(new DomainError("EXPEDITED", "有加急输入"));
      });
      let message: import("@earendil-works/pi-ai").AssistantMessage;
      try {
        message = await model.turn(
          AbortSignal.any([ctx.signal, inferenceAbort.signal]),
          async (partial) => {
            ctx.progress();
            if (Date.now() - lastEmission < 250) return;
            lastEmission = Date.now();
            await streamingMessage.write(
              partial.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n"),
              partial.content
                .flatMap((p) => (p.type === "thinking" ? [p.thinking] : []))
                .join("\n"),
              true,
            );
          },
        );
      } catch (error) {
        if (inferenceAbort.signal.aborted && !ctx.signal.aborted) {
          await ctx.store.event(ctx.run, "message", {
            id: `${ctx.run.attemptId}-${round}`,
            text: "",
            thinking: "",
            streaming: false,
            interrupted: true,
          });
          budget = Math.max(0, budget - 1);
          continue;
        }
        throw error;
      } finally {
        await stopMonitor();
      }
      ctx.progress();
      if (closing)
        message.content = message.content.map((part) =>
          part.type === "toolCall"
            ? {
                type: "text",
                text: promptText(
                  input.language,
                  `[Tool ${part.name} was not executed: the turn limit was reached.]`,
                  `[工具 ${part.name} 未执行：已达到本次执行的回合上限。]`,
                ),
              }
            : part,
        );
      if (closing && !message.content.some((p) => p.type === "text" && p.text.trim())) {
        const pending = (
          await conversations.db.pool.query(
            "select name,state from tool_calls where run_id=$1 and state in('prepared','dispatching','waiting','unknown') order by created_at",
            [ctx.run.id],
          )
        ).rows;
        message.content.push({
          type: "text",
          text: promptText(
            input.language,
            `The tool-turn limit was reached without a usable model summary. The task has not been verified complete. Unfinished tools: ${pending.map((p) => `${p.name} (${p.state})`).join(", ") || "none"}. Send a message to continue.`,
            `已达到工具回合上限，模型未返回有效总结，尚不能确认任务完成。未完成工具：${pending.map((p) => `${p.name}（${p.state}）`).join("、") || "无"}。发送消息可继续。`,
          ),
        });
      }
      if (closing) exhausted = true;
      pendingTurnId = id("turn");
      toolSchemaVersion = TOOL_SCHEMA_VERSION;
      await conversations.db.canvas(ctx.run.canvas_id, async (tx) => {
        await assertFence(tx, ctx.run.id, ctx.run.epoch);
        await conversations.append(
          tx,
          input.conversationId,
          `${ctx.run.attemptId}:assistant:${round}`,
          "assistant",
          {
            text: message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n"),
            thinking: message.content
              .flatMap((p) => (p.type === "thinking" ? [p.thinking] : []))
              .join("\n"),
            stopReason: message.stopReason,
            usage: message.usage,
            reviewBasis: { executionHash: answerExecution.hash, consumedInputSeq: consumed },
          },
          ctx.run.id,
        );
        await persist(tx);
      });
      await streamingMessage.write(
        message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n"),
        message.content.flatMap((p) => (p.type === "thinking" ? [p.thinking] : [])).join("\n"),
        false,
      );
      if (closing) {
        waitingForInput = true;
        // Keep the original executor alive for durable background results.
        // The next iteration consumes new input instead of draining tools here.
        if (await finishIfIdle()) return;
        continue;
      }
      if (!message.content.some((p) => p.type === "toolCall")) {
        const stopped = await finishIfIdle();
        if (stopped) return;
      }
    }
  } finally {
    await background.close();
  }
}
