import type { createCanvasAgent } from "../../adapters/model/agent.js";
import { contextUsage } from "../../adapters/model/context.js";
import type { ModelConfig } from "../../adapters/model/types.js";
import { canvasEvent, type Tx } from "../../adapters/postgres/database.js";
import type { ExecutionContext } from "../execution/worker.js";
import type { OutputCompletion } from "./complete-turn.js";
import type { ConversationInput } from "./conversations.js";

export async function saveCheckpoint(
  tx: Tx,
  ctx: ExecutionContext,
  input: ConversationInput,
  model: ReturnType<typeof createCanvasAgent>,
  config: ModelConfig,
  consumed: string,
  consumedInContext: Set<string>,
  compactions: number,
  pendingTurnId: string,
  toolSchemaVersion: number,
  budget: number,
  exhausted: boolean,
  completionState: OutputCompletion["state"],
) {
  const received = await tx.query(
    "update messages set consumed_run_id=$3,consumed_at=now() where conversation_id=$1 and seq=any($2::bigint[]) and consumed_run_id is null returning client_message_id,content",
    [input.conversationId, [...consumedInContext], ctx.run.id],
  );
  for (const row of received.rows)
    if (row.content.sourceConversationId) {
      await tx.query(
        "update messages set consumed_run_id=$3,consumed_at=now() where conversation_id=$1 and seq=$2 and consumed_run_id is null",
        [row.content.sourceConversationId, row.content.sourceMessageSeq, ctx.run.id],
      );
      await canvasEvent(tx, ctx.run.canvas_id, "conversation.changed", {
        conversationId: row.content.sourceConversationId,
      });
    }
  if (received.rowCount) {
    const messageIds = received.rows.map((m) => m.client_message_id);
    await ctx.store.eventTx(tx, ctx.run.id, ctx.run.attemptId, "input.receipt", {
      conversationId: input.conversationId,
      messageIds,
      state: "read",
    });
    await canvasEvent(tx, ctx.run.canvas_id, "conversation.changed", {
      conversationId: input.conversationId,
      agentId: input.agentId,
      consumedMessageIds: messageIds,
    });
  }
  consumedInContext.clear();
  const info = {
    ...contextUsage(model, config),
    compactions,
    pendingTurnId,
    toolSchemaVersion,
    turnsSinceInput: budget,
    turnLimitReached: exhausted,
    workItemId: input.workItemId,
    outputGeneration: input.generation,
    ...completionState,
  };
  await tx.query(
    "update conversations set checkpoint=$2,consumed_message_seq=$3,context=$4 where id=$1",
    [
      input.conversationId,
      JSON.stringify(
        ctx.store.media
          ? await ctx.store.media.pack(model.state.messages, input.conversationId, undefined, tx)
          : model.state.messages,
      ),
      consumed,
      JSON.stringify(info),
    ],
  );
}
