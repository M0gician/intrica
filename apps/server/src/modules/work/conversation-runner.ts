import { createCanvasAgent } from "../../adapters/model/agent.js";
import { contextUsage } from "../../adapters/model/context.js";
import { buildClosingPrompt, buildConversationPrompt } from "../../adapters/model/prompt.js";
import {
  assertFence,
  canvasEvent,
  DomainError,
  digest,
  id,
  type Tx,
} from "../../adapters/postgres/database.js";
import { promptLanguage } from "../../prompt-language.js";
import { agentIdentity } from "../access/policy.js";
import { messagePromptContext } from "../collaboration/prompt-context.js";
import { BackgroundTools } from "../execution/background-tools.js";
import {
  type ExecutionTool,
  TOOL_SCHEMA_VERSION,
  type ToolExecution,
} from "../execution/tool-calls.js";
import type { ExecutionContext } from "../execution/worker.js";
import { infer } from "../inference/coordinator.js";
import { recoverInference } from "../inference/recovery.js";
import { saveCheckpoint } from "./checkpoints.js";
import { OutputCompletion } from "./complete-turn.js";
import { appendContextInput, compactContext } from "./context-builder.js";
import type { ConversationInput, Conversations, ToolsFactory } from "./conversations.js";
import { conversationPromptPolicy } from "./prompt-policy.js";
import { admitTools } from "./tool-admission.js";
import { holdForTools } from "./tool-wait.js";
import { activateWork, selectWorkInput, unfinishedReplyReason, waitForWork } from "./work-items.js";

export async function executeConversation(
  service: Conversations,
  ctx: ExecutionContext,
  factory: ToolsFactory,
) {
  const input = ctx.run.frozen_input as ConversationInput;
  const config = await service.models.materialize(input.model);
  const model = createCanvasAgent(config, ctx.run.id);
  model.explicitMessages = true;
  if (ctx.store.media)
    model.prepareMessages = (messages) => ctx.store.media!.hydrate(messages, input.conversationId);
  const conversation = (
    await service.db.pool.query("select * from conversations where id=$1", [input.conversationId])
  ).rows[0];
  if (!conversation) throw new DomainError("NOT_FOUND", "会话已删除");
  model.state.messages = conversation.checkpoint;
  input.generation = Number(conversation.context?.outputGeneration ?? conversation.generation);
  input.workItemId = conversation.context?.workItemId ?? input.workItemId;
  const completion = new OutputCompletion(service, ctx, input, conversation.context);
  let messageContext = await messagePromptContext(
    service.db.pool,
    input.conversationId,
    input.workItemId,
  );
  let identity = input.agentId ? await agentIdentity(service.db.pool, input.agentId) : null;
  const savedLanguage = (
    await service.db.pool.query(
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
        schemaVersion: TOOL_SCHEMA_VERSION,
        executionSchemaHash: digest(t.parameters),
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
      identity = await agentIdentity(service.db.pool, input.agentId);
    tools.splice(0, tools.length, ...next);
    setPrompt();
    return modelTools(tools);
  };
  const setPrompt = (withTools = true) => {
    model.state.systemPrompt = buildConversationPrompt(input.language ?? "en", {
      agent: Boolean(identity),
      persona: capabilities?.persona ?? identity?.config.persona,
      capabilities,
      role: capabilities?.role ?? identity?.config.role ?? "owner",
      availableTools: withTools
        ? tools.filter((tool) => tool.modelVisible !== false).map((tool) => tool.name)
        : [],
      selection: input.selection,
      asyncSeconds: ctx.store.limits.toolAsyncAfterMs / 1000,
      policy: conversationPromptPolicy(ctx.store.limits),
    });
    model.state.systemPrompt += `\nCurrent message requests (server metadata): ${JSON.stringify(messageContext)}\nCurrent work item: ${input.workItemId ?? "none"}. Each outgoing message declares its own target.`;
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
  const persist = (tx: Tx) =>
    saveCheckpoint(
      tx,
      ctx,
      input,
      model,
      config,
      consumed,
      consumedInContext,
      compactions,
      pendingTurnId,
      toolSchemaVersion,
      budget,
      exhausted,
      completion.state,
    );
  const checkpoint = () =>
    service.db.canvas(ctx.run.canvas_id, async (tx) => {
      await assertFence(tx, ctx.run.id, ctx.run.epoch);
      await persist(tx);
    });
  const hasUnread = async (sql: Pick<Tx, "query">) =>
    (await selectWorkInput(sql, input.conversationId, consumed, input.workItemId)).ready;
  const expedited = async () =>
    Boolean(
      (
        await service.db.pool.query(
          "select 1 from messages where conversation_id=$1 and consumed_run_id is null and content->>'closed' is distinct from 'true' and expedite_run_id=$2 limit 1",
          [input.conversationId, ctx.run.id],
        )
      ).rowCount,
    );
  const logTool = async (tx: Tx, event: Record<string, unknown>) => {
    const key = `tool-${ctx.run.id}-${event.id}`;
    await service.append(tx, input.conversationId, key, "tool", event, ctx.run.id);
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
    await service.append(tx, input.conversationId, key, "tool_update", content, ctx.run.id);
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
    const native = (
      await tx.query(
        "select 1 from message_dispatches where run_id=$1 and state='waiting' and output_handled=false limit 1",
        [ctx.run.id],
      )
    ).rowCount;
    return rows.some((r) => r.state === "unknown")
      ? "unknown"
      : rows.length || native
        ? "approval"
        : null;
  };
  let backgroundWaiting = ctx.run.reason === "background";
  const waitingOnBackground = async (waiting: boolean) => {
    if (backgroundWaiting === waiting) return;
    const reason = waiting ? "background" : null;
    await service.db.canvas(ctx.run.canvas_id, async (tx) => {
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
  const finishIfIdle = async () => {
    await completion.restoreReady();
    if (completion.pending) return false;
    if ((await background.pendingIn(service.db.pool)) || (await hasUnread(service.db.pool)))
      return false;
    const reason =
      (await humanReason(service.db.pool)) ??
      (completion.blocked
        ? "message_protocol"
        : exhausted
          ? "turn_limit"
          : await unfinishedReplyReason(service.db.pool, input.conversationId));
    return ctx.store.finish(
      ctx.run,
      reason ? "waiting" : "succeeded",
      async (tx) => {
        if (
          (await hasUnread(tx)) ||
          (await background.pendingIn(tx)) ||
          ((await humanReason(tx)) ??
            (completion.blocked
              ? "message_protocol"
              : exhausted
                ? "turn_limit"
                : await unfinishedReplyReason(tx, input.conversationId))) !== reason
        )
          return false;
        await persist(tx);
      },
      reason,
    );
  };
  try {
    await recoverInference(ctx);
    await background.resume();
    const round = 0;
    let waitingForInput = false;
    for (;;) {
      ctx.signal.throwIfAborted();
      if (await completion.resume(model, persist, checkpoint)) return;
      if (completion.blocked && !(await hasUnread(service.db.pool)) && !(await expedited())) {
        await ctx.store.finish(
          ctx.run,
          "waiting",
          async (tx) => {
            await persist(tx);
          },
          "message_protocol",
        );
        return;
      }
      if (completion.blocked) completion.resetRepair();
      await refreshTools();
      await background.deliver();
      const last = model.state.messages.at(-1);
      if (
        !last ||
        (last.role === "assistant" && !last.content.some((p) => p.type === "toolCall")) ||
        waitingForInput
      ) {
        if (await finishIfIdle()) return;
        if (!(await hasUnread(service.db.pool))) {
          await waitingOnBackground(true);
          await background.wait();
          continue;
        }
        waitingForInput = false;
      }
      // Resume all stored groups with their original identity before the next model request.
      try {
        await admitTools(
          ctx,
          model,
          tools,
          background,
          pendingTurnId,
          toolSchemaVersion,
          checkpoint,
        );
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "INFERENCE_TOOL_WAIT") throw error;
        const waiting = (error.details as { waiting: NonNullable<ToolExecution["waiting"]> })
          .waiting;
        const held = await holdForTools(ctx, background, input, waiting, persist, hasUnread);
        if (held.stopped) return;
        waitingForInput = held.waitingForInput;
        continue;
      }

      const selection = await selectWorkInput(
        service.db.pool,
        input.conversationId,
        consumed,
        input.workItemId,
      );
      if (selection.workItemId !== input.workItemId) {
        completion.resetRepair();
        if (selection.workItemId && !selection.messages.length)
          model.state.messages.push({
            role: "user",
            timestamp: Date.now(),
            content: `Server task selection: Resume work item ${selection.workItemId} using the continuous context. Preserve completed work and delivery receipts.`,
          });
      }
      input.workItemId = selection.workItemId;
      const unread = selection.messages;
      await service.db.canvas(ctx.run.canvas_id, async (tx) => {
        await assertFence(tx, ctx.run.id, ctx.run.epoch);
        await activateWork(tx, input.conversationId, input.workItemId);
      });
      // A user can steer the original run while its background work continues.
      // A fresh budget requires explicit input, not periodic progress notices.
      if (unread.some((m) => m.role === "user")) {
        budget = 0;
        exhausted = false;
        completion.resetRepair();
      }
      const closing =
        ctx.store.limits.conversationTurns > 0 && budget >= ctx.store.limits.conversationTurns;
      await waitingOnBackground(false);
      consumed = await appendContextInput(
        service,
        input,
        model,
        unread,
        consumed,
        consumedInContext,
      );
      if (!closing) budget++;
      await checkpoint();
      // Read batches remain bounded. Reach the selected expedited input before inferring again.
      if (await expedited()) continue;
      const usage = contextUsage(model, config);
      if (usage.tokens >= usage.safeLimit) {
        compactions++;
        await compactContext(
          service,
          input,
          ctx,
          model,
          config,
          capabilities?.saveMemory ?? identity?.config.saveMemoryBeforeCompaction !== false,
          round,
          persist,
        );
        // Inputs accepted during the fixed summary request join the next inference context.
        if (await hasUnread(service.db.pool)) {
          if (!closing) budget = Math.max(0, budget - 1);
          continue;
        }
      }
      // Refresh after input and compaction, immediately before every model request.
      messageContext = await messagePromptContext(
        service.db.pool,
        input.conversationId,
        input.workItemId,
      );
      const generation = await service.db.canvas(ctx.run.canvas_id, async (tx) => {
        await assertFence(tx, ctx.run.id, ctx.run.epoch);
        const pending = (
          await tx.query(
            "select 1 from messages where conversation_id=$1 and consumed_run_id is null and content->>'closed' is distinct from 'true' and expedite_run_id=$2 limit 1",
            [input.conversationId, ctx.run.id],
          )
        ).rowCount;
        return pending
          ? null
          : Number(
              (
                await tx.query("select generation from conversations where id=$1", [
                  input.conversationId,
                ])
              ).rows[0].generation,
            );
      });
      if (generation === null) continue;
      input.generation = generation;
      const currentTools = await refreshTools();
      model.state.tools = closing ? [] : currentTools;
      if (closing) {
        setPrompt(false);
        model.state.systemPrompt += `\n${buildClosingPrompt(input.language ?? "en")}`;
      }
      const generatedTurnId = id("turn");
      pendingTurnId = generatedTurnId;
      toolSchemaVersion = TOOL_SCHEMA_VERSION;
      const message = await infer(
        model,
        ctx,
        background,
        expedited,
        generatedTurnId,
        input.workItemId,
        generation,
        {
          persist,
          checkpoint,
          refresh: async () => {
            messageContext = await messagePromptContext(
              service.db.pool,
              input.conversationId,
              input.workItemId,
            );
            const current = await refreshTools();
            model.state.tools = closing ? [] : current;
            if (closing) {
              setPrompt(false);
              model.state.systemPrompt += `\n${buildClosingPrompt(input.language ?? "en")}`;
            }
          },
          admitTools: (interrupt) =>
            admitTools(
              ctx,
              model,
              tools,
              background,
              pendingTurnId,
              toolSchemaVersion,
              checkpoint,
              interrupt,
            ),
        },
      );
      if (message && "waiting" in message) {
        const held = await holdForTools(
          ctx,
          background,
          input,
          message.waiting,
          persist,
          hasUnread,
        );
        if (held.stopped) return;
        waitingForInput = held.waitingForInput;
        continue;
      }
      if (!message) {
        budget = Math.max(0, budget - 1);
        continue;
      }
      ctx.progress();
      if (closing) exhausted = true;
      pendingTurnId = generatedTurnId;
      toolSchemaVersion = TOOL_SCHEMA_VERSION;
      await service.db.canvas(ctx.run.canvas_id, async (tx) => {
        await assertFence(tx, ctx.run.id, ctx.run.epoch);
        const text = message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
        const thinking = message.content
          .flatMap((p) => (p.type === "thinking" ? [p.thinking] : []))
          .join("\n");
        const generation = Number(
          (
            await tx.query("select generation from conversations where id=$1", [
              input.conversationId,
            ])
          ).rows[0].generation,
        );
        if (generation === input.generation) {
          const correction =
            text.trim() || !message.content.some((p) => p.type === "toolCall")
              ? await completion.prepare(tx, text, pendingTurnId, thinking, generation)
              : null;
          if (correction && !completion.blocked) model.state.messages.push(correction);
          await service.append(
            tx,
            input.conversationId,
            `generation-${pendingTurnId}`,
            "model_output",
            {
              text,
              thinking,
              stopReason: message.stopReason,
              usage: message.usage,
              generation,
              generationId: pendingTurnId,
              workItemId: input.workItemId,
              state: "unpublished",
            },
            ctx.run.id,
          );
        }
        await persist(tx);
      });
      if (completion.pending || completion.repairAttempts > 0) continue;
      if (!message.content.some((p) => p.type === "toolCall"))
        await service.db.canvas(ctx.run.canvas_id, (tx) =>
          waitForWork(tx, input.conversationId, input.workItemId, "reply_required"),
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
