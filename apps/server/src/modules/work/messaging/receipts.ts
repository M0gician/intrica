import type { CollaborationReceipt } from "@intrica/contracts";
import { digest, type Sql } from "../../../adapters/postgres/database.js";
import { deliveryFields, deliveryJoins } from "./deliveries.js";

/** One batch for an entire page, shared by transcript, collaboration feed and full records. */
export async function projectCollaborationReceipts(
  sql: Sql,
  records: any[],
  conversationId?: string,
) {
  const conversations = [
    ...new Set(records.map((r) => r.conversation_id ?? conversationId).filter(Boolean)),
  ];
  const messageIds = records.map((r) => r.client_message_id).filter(Boolean);
  const deliveryIds = records.map((r) => r.content?.deliveryId).filter(Boolean);
  if (!messageIds.length && !deliveryIds.length) return;
  const rows = (
    await sql.query(
      `select ${deliveryFields},reply.seq as reply_seq ${deliveryJoins}
    left join messages reply on reply.conversation_id=q.sender_conversation_id
      and reply.client_message_id=case when q.sender_agent_id is null then 'reply-'||q.reply_call_id
        else 'delivery-'||q.reply_call_id||'-'||q.sender_agent_id end
    where (q.sender_conversation_id=any($1::text[]) and q.source_message_id=any($2::text[]))
      or q.id=any($3::text[])`,
      [conversations, messageIds, deliveryIds],
    )
  ).rows;
  const projection = (q: any): CollaborationReceipt => ({
    deliveryId: q.id,
    recipientId: q.recipient_agent_id,
    recipientName: q.recipientName ?? "",
    state: q.closed ? "closed" : q.readAt ? "read" : "unread",
    readAt: q.readAt?.toISOString() ?? null,
    expectReply: q.expect_reply,
    replied: q.state === "replied",
    replyMessageId: q.reply_call_id ? `send-${q.reply_call_id}` : null,
    replyConversationId: q.reply_seq ? q.sender_conversation_id : null,
    replySeq: q.reply_seq ? Number(q.reply_seq) : null,
    priority: q.expedited_at ? "expedited" : "normal",
    expeditedAt: q.expedited_at?.toISOString() ?? null,
    expediteReadAt: q.expediteReadAt?.toISOString() ?? null,
    paused: q.paused,
    blocked: q.blocked,
    tracking: q.state === "open" && !q.tracking_stopped && (!q.readAt || q.expect_reply),
    version: q.version,
  });
  for (const record of records) {
    const receipts = rows
      .filter((q) =>
        record.content?.from
          ? q.id === record.content.deliveryId
          : q.sender_conversation_id === (record.conversation_id ?? conversationId) &&
            q.source_message_id === record.client_message_id,
      )
      .map(projection);
    if (!receipts.length) continue;
    record.content = {
      ...record.content,
      deliveryReceipts: receipts,
      ...(receipts.some((r) => r.priority === "expedited") ? { priority: "expedited" } : {}),
    };
    record.record_version = digest([record.record_version, receipts]);
  }
}

/** Receiver input consumption invalidates the sender's receipt projection too. */
export async function publishDeliveryReads(sql: Sql, conversationId: string, messageIds: string[]) {
  const rows = (
    await sql.query(
      `select distinct q.canvas_id,q.sender_conversation_id,c.agent_id
    from message_deliveries q join conversations c on c.id=q.sender_conversation_id
    where q.recipient_conversation_id=$1 and (q.inbox_message_id=any($2::text[]) or q.expedite_message_id=any($2::text[]))`,
      [conversationId, messageIds],
    )
  ).rows;
  return rows;
}
