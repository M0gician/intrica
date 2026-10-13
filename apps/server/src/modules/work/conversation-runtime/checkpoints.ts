import { contextUsage } from "../../../adapters/model/context.js";
import { canvasEvent, type Tx } from "../../../adapters/postgres/database.js";
import type { ExecutionContext } from "../../execution/worker.js";
import type { ConversationInput } from "../conversations.js";
import { publishDeliveryReads } from "../messaging/receipts.js";
export function createCheckpointWriter(
  ctx: ExecutionContext,
  input: ConversationInput,
  model: Parameters<typeof contextUsage>[0],
  config: Parameters<typeof contextUsage>[1],
  consumedInContext: Set<string>,
  snapshot: () => {
    consumed: string;
    compactions: number;
    pendingTurnId: string;
    toolSchemaVersion: number;
    budget: number;
    exhausted: boolean;
  },
) {
  return async (tx: Tx) => {
    const { consumed, compactions, pendingTurnId, toolSchemaVersion, budget, exhausted } =
      snapshot();

    const received = await tx.query(
      "update messages set consumed_run_id=$3,consumed_at=now() where conversation_id=$1 and seq=any($2::bigint[]) and consumed_run_id is null returning client_message_id",
      [input.conversationId, [...consumedInContext], ctx.run.id],
    );
    if (received.rowCount) {
      const messageIds = received.rows.map((m) => m.client_message_id);
      for (const source of await publishDeliveryReads(tx, input.conversationId, messageIds))
        await canvasEvent(tx, source.canvas_id, "conversation.changed", {
          conversationId: source.sender_conversation_id,
          agentId: source.agent_id,
        });
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
  };
}
