import type { Agent } from "../../../adapters/model/agent.js";
import type { ModelConfig } from "../../../adapters/model/types.js";
import { assertFence, type Tx } from "../../../adapters/postgres/database.js";
import { summaryMessage } from "../../context/messages.js";
import { summarizeContext } from "../../context/summary.js";
import { appendMessage } from "../../execution/messages.js";
import type { ExecutionContext } from "../../execution/worker.js";
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
  saveMemory: boolean,
  persist: (tx: Tx) => Promise<void>,
  count: () => void,
) {
  const previous = model.state.messages;
  await ctx.store.event(ctx.run, "compaction", { state: "running" });
  const summary = await summarizeContext(
    config,
    await model.prepareMessages(previous),
    saveMemory,
    ctx.signal,
    input.language,
  );
  ctx.signal.throwIfAborted();
  model.state.messages = withOriginalInstructions(
    [
      summaryMessage(model.state.model, summary.id, summary.content, input.language ?? "en"),
      ...summary.retainedTail,
    ],
    sources,
    input.language ?? "en",
  );
  try {
    await ctx.store.db.canvas(ctx.run.canvas_id, async (tx) => {
      await assertFence(tx, ctx.run.id, ctx.run.epoch);
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
      if (summary.content.memory_text)
        await appendMessage(
          tx,
          input.conversationId,
          summary.id,
          "memory",
          { title: summary.content.memory_title, text: summary.content.memory_text },
          ctx.run.id,
        );
      count();
      await persist(tx);
    });
    await ctx.store.event(ctx.run, "compaction", { state: "succeeded", summaryId: summary.id });
  } catch (error) {
    model.state.messages = previous;
    throw error;
  }
}
