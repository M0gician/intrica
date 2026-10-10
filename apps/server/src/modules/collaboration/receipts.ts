import type { MessageRequestView } from "@intrica/contracts";
import type { Sql } from "../../adapters/postgres/database.js";
import { inputReceiptState } from "../execution/messages.js";

/** Request state and context consumption are separate facts. */
export async function conversationRequests(
  sql: Sql,
  conversationId: string,
): Promise<MessageRequestView[]> {
  return (
    await sql.query(
      `select q.id,q.state,q.work_state as "workState",q.reply_message_id as "replyMessageId",
    q.blocked_reason as "blockedReason",q.sender_kind as "senderKind",q.recipient_kind as "recipientKind",
    q.sender_conversation_id as "senderConversationId",q.recipient_conversation_id as "recipientConversationId",
    q.origin_work_item_id as "originWorkItemId",q.parent_request_id as "parentRequestId",
    case when q.recipient_conversation_id=$1 and q.recipient_kind<>'user' then 'incoming' else 'outgoing' end as direction,
    coalesce(sn.body->>'title',q.sender_kind) as "senderName",coalesce(rn.body->>'title',q.recipient_kind) as "recipientName",
    left(coalesce(m.content->>'text',d.payload->>'message',''),160) as summary,
    q.created_at as "createdAt",q.updated_at as "updatedAt"
    from message_requests q left join nodes sn on sn.id=q.sender_agent_id left join nodes rn on rn.id=q.recipient_agent_id
    left join message_dispatches d on d.id=q.message_id
    left join lateral (select content from messages where conversation_id=q.recipient_conversation_id
      and content->>'collaborationRequestId'=q.id order by seq limit 1) m on true
    where q.sender_conversation_id=$1 or q.recipient_conversation_id=$1
    order by (q.state='open') desc,q.created_at desc,q.id limit 100`,
      [conversationId],
    )
  ).rows;
}

export async function projectMessageReceipts(sql: Sql, records: any[], conversationId: string) {
  const dispatchIds = records.map((r) => r.content.messageId).filter(Boolean);
  const requestIds = records
    .flatMap((r) => [r.content.collaborationRequestId, r.content.inReplyTo])
    .filter(Boolean);
  if (!dispatchIds.length && !requestIds.length) return;
  const requests = (
    await sql.query(
      `select q.id,q.message_id,q.state,q.work_state as "workState",q.blocked_reason as "blockedReason",
    left(coalesce(m.content->>'text',d.payload->>'message',''),160) as summary
    from message_requests q left join message_dispatches d on d.id=q.message_id
    left join lateral (select content from messages where conversation_id=q.recipient_conversation_id
      and content->>'collaborationRequestId'=q.id order by seq limit 1) m on true
    where (q.id=any($1::text[]) or q.message_id=any($2::text[]))
      and (q.sender_conversation_id=$3 or q.recipient_conversation_id=$3)`,
      [requestIds, dispatchIds, conversationId],
    )
  ).rows;
  const deliveries = dispatchIds.length
    ? (
        await sql.query(
          `select m.content->>'messageId' as message_id,
    m.client_message_id as "messageId",m.conversation_id as "conversationId",m.consumed_at as "readAt",
    m.created_at as "deliveredAt",extract(epoch from(coalesce(m.consumed_at,now())-m.created_at))::int as "elapsedSeconds",
    case when m.role='assistant' then 'delivered' else ${inputReceiptState} end as state
    from messages m join conversations c on c.id=m.conversation_id left join runs r on r.id=m.run_id
    where m.content->>'messageId'=any($1::text[]) and (m.content ? 'from' or m.role='assistant')`,
          [dispatchIds],
        )
      ).rows
    : [];
  for (const record of records) {
    const c = record.content;
    c.messageRequests = requests.filter(
      (q) =>
        q.id === c.collaborationRequestId || q.id === c.inReplyTo || q.message_id === c.messageId,
    );
    if (c.messageId && record.role !== "internal_note")
      c.deliveries = deliveries.filter((d) => d.message_id === c.messageId);
  }
}
