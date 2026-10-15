import type { Agent } from "../../../adapters/model/agent.js";
import { contextUsage } from "../../../adapters/model/context.js";
import type { ModelConfig } from "../../../adapters/model/types.js";
import { assertFence, DomainError, type Tx } from "../../../adapters/postgres/database.js";
import { contextFailure } from "../../context/errors.js";
import { summaryMessage } from "../../context/messages.js";
import { summarizeContext } from "../../context/summary.js";
import type { ExecutionContext } from "../../execution/worker.js";
import { persistContextArchive } from "../context-library/archive.js";
import type { ConversationInput } from "../conversations.js";
import {
  type InstructionSource,
  sourceBoundary,
  withOriginalInstructions,
} from "../progress/sources.js";

/** Freeze evidence before inference and commit only under the current run fence. */
export async function compactConversation(
  ctx: ExecutionContext,
  input: ConversationInput,
  model: Agent,
  config: ModelConfig,
  sources: InstructionSource[],
  persist: (tx: Tx) => Promise<void>,
  count: (delta: number) => void,
) {
  const previous = model.state.messages;
  const language = input.language ?? "en";
  const usage = (messages: typeof previous) =>
    contextUsage(model, config, messages, { estimateOnly: true });
  const before = usage(previous);
  const diagnostics = {
    beforeTokens: before.tokens,
    safeLimit: before.safeLimit,
    sourceCount: null as number | null,
    afterTokens: null as number | null,
    phase: "source",
  };
  let counted = false;
  await ctx.store.event(ctx.run, "compaction", { state: "running", ...diagnostics });
  try {
    ctx.signal.throwIfAborted();
    if (usage([]).tokens >= before.safeLimit)
      throw contextFailure("CONTEXT_COMPACTION_LIMIT", language);
    if (usage(withOriginalInstructions([], sources, language)).tokens >= before.safeLimit)
      throw contextFailure("INSTRUCTION_CONTEXT_LIMIT", language);
    diagnostics.phase = "summary";
    const summary = await summarizeContext(
      config,
      await model.prepareMessages(previous),
      ctx.signal,
      language,
      (count) => {
        diagnostics.sourceCount = count;
      },
    );
    ctx.signal.throwIfAborted();
    diagnostics.phase = "candidate";
    diagnostics.sourceCount = summary.sources.length;
    if (!summary.sources.length) throw contextFailure("CONTEXT_EMPTY_SOURCE", language);
    const candidate = withOriginalInstructions(
      [
        summaryMessage(model.state.model, summary.id, summary.content, language),
        ...summary.retainedTail,
      ],
      sources,
      language,
    );
    diagnostics.afterTokens = usage(candidate).tokens;
    if (diagnostics.afterTokens >= before.safeLimit || diagnostics.afterTokens >= before.tokens)
      throw contextFailure("CONTEXT_COMPACTION_LIMIT", language);
    diagnostics.phase = "commit";
    await ctx.store.db.canvas(ctx.run.canvas_id, async (tx) => {
      await assertFence(tx, ctx.run.id, ctx.run.epoch);
      ctx.signal.throwIfAborted();
      await tx.query(
        `insert into context_summaries(id,conversation_id,run_id,request_id,source_hash,source_refs,instruction_hash,content,previous_checkpoint,context_version)
         select $1,id,$3,$4,$5,$6,$7,$8,checkpoint,context_version from conversations where id=$2`,
        [
          summary.id,
          input.conversationId,
          ctx.run.id,
          summary.requestId,
          summary.sourceHash,
          JSON.stringify(summary.sources),
          sourceBoundary(sources),
          JSON.stringify(summary.content),
        ],
      );
      await persistContextArchive(tx, {
        summaryId: summary.id,
        conversationId: input.conversationId,
        canvasId: ctx.run.canvas_id,
        agentId: input.agentId ?? null,
        sourceMessages: summary.sourceMessages,
      });
      model.state.messages = candidate;
      count(1);
      counted = true;
      await persist(tx);
      ctx.signal.throwIfAborted();
      await ctx.store.eventTx(tx, ctx.run.id, ctx.run.attemptId, "compaction", {
        state: "succeeded",
        summaryId: summary.id,
        ...diagnostics,
      });
      ctx.signal.throwIfAborted();
    });
  } catch (error) {
    model.state.messages = previous;
    if (counted) count(-1);
    await ctx.store
      .event(ctx.run, "compaction", {
        state: ctx.signal.aborted ? "cancelled" : "failed",
        code:
          error instanceof DomainError
            ? error.code
            : error instanceof Error && error.message.startsWith("CONTEXT_SUMMARY_INVALID:")
              ? "CONTEXT_SUMMARY_INVALID"
              : "CONTEXT_COMPACTION_FAILED",
        ...diagnostics,
      })
      .catch(() => {});
    throw error;
  }
}
