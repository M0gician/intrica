import { type Database, DomainError } from "../../adapters/postgres/database.js";
import { expediteMessage } from "../collaboration/urgency.js";
import { inputReceiptState } from "../execution/messages.js";

export async function expediteInput(
  db: Database,
  conversationId: string,
  messageId: string,
): Promise<{ state: string; messageId: string }> {
  const conversation = (
    await db.pool.query("select * from conversations where id=$1", [conversationId])
  ).rows[0];
  if (!conversation) throw new DomainError("NOT_FOUND", "会话不存在");
  const forwarded = (
    await db.pool.query(
      "select content from messages where conversation_id=$1 and client_message_id=$2 and role='user'",
      [conversationId, messageId],
    )
  ).rows[0]?.content;
  if (forwarded?.forwardedTo) {
    const target = (
      await db.pool.query(
        "select client_message_id from messages where conversation_id=$1 and seq=$2",
        [forwarded.forwardedTo, forwarded.forwardedSeq],
      )
    ).rows[0];
    const receipt = await expediteInput(db, forwarded.forwardedTo, target.client_message_id);
    return { ...receipt, messageId };
  }
  return db.canvas(conversation.canvas_id, (tx) => expediteMessage(tx, conversationId, messageId));
}

export async function projectInputReceipts(db: Database, records: any[], conversationId: string) {
  const ids = records
    .filter((r) => r.role === "user" || (r.role === "message" && r.content.from))
    .map((r) => r.seq);
  if (!ids.length) return records;
  const rows = (
    await db.pool.query(
      `select m.seq,m.client_message_id,m.consumed_run_id,m.consumed_at,m.expedite_requested_at,m.created_at,
    ${inputReceiptState} as state
    from messages m join conversations c on c.id=m.conversation_id left join runs r on r.id=m.run_id
    where m.conversation_id=$1 and m.seq=any($2::bigint[])`,
      [conversationId, ids],
    )
  ).rows;
  const receipts = new Map(
    rows.map((r) => [
      String(r.seq),
      {
        messageId: r.client_message_id,
        state: r.state,
        consumedRunId: r.consumed_run_id,
        consumedAt: r.consumed_at,
        deliveredAt: r.created_at,
        elapsedSeconds: Math.max(
          0,
          Math.floor((Date.now() - new Date(r.created_at).getTime()) / 1000),
        ),
      },
    ]),
  );
  for (const record of records)
    if (record.role === "user" || (record.role === "message" && record.content.from))
      record.content = { ...record.content, inputReceipt: receipts.get(String(record.seq)) };
  return records;
}
