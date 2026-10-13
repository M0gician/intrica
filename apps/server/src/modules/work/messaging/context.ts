import type { Database, Tx } from "../../../adapters/postgres/database.js";
import { DomainError } from "../../../adapters/postgres/database.js";
import type { Conversations } from "../conversations.js";

export type MessagingContext = {
  db: Database;
  conversations: Pick<Conversations, "append" | "language" | "runs">;
};

/** Agent inbox admission also retries through AccessService. Owner inboxes have no Agent scanner. */
export async function wakeInbox(
  context: MessagingContext,
  tx: Tx,
  conversationId: string,
  causeId: string,
) {
  const paused = (
    await tx.query(
      "select a.paused from conversations c join agent_configs a on a.node_id=c.agent_id where c.id=$1",
      [conversationId],
    )
  ).rows[0]?.paused;
  if (paused) return;
  const barrier = await context.conversations.runs.conversationBarrier(conversationId, tx);
  if (barrier.paused || barrier.unknown) return;
  const latest = (
    await tx.query(
      "select * from runs where subject_id=$1 order by created_at desc,id desc limit 1",
      [conversationId],
    )
  ).rows[0];
  if (!latest || latest.cancel_requested_at || latest.state === "cancelled") return;
  if (latest.state === "running" || latest.state === "queued") {
    await tx.query("select pg_notify('intrica_run_wake',$1)", [latest.id]);
    return;
  }
  await tx.query("savepoint message_wake");
  try {
    await context.conversations.runs.enqueue(tx, {
      canvasId: latest.canvas_id,
      subjectId: conversationId,
      kind: "conversation",
      frozen: latest.frozen_input,
      causeId,
    });
  } catch (error) {
    await tx.query("rollback to savepoint message_wake");
    if (
      !(error instanceof DomainError) ||
      !["LIMIT_REACHED", "QUEUE_FULL", "AGENT_PAUSED"].includes(error.code)
    )
      throw error;
  }
  await tx.query("release savepoint message_wake");
}
