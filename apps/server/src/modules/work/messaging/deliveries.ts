import { DomainError, id, type Sql, type Tx } from "../../../adapters/postgres/database.js";
import type { Run } from "../../execution/store.js";

export async function recordDelivery(
  tx: Tx,
  run: Run,
  senderId: string | null,
  recipient: { id: string; agent_id: string },
  source: { callId?: string; messageId: string; inboxId: string },
  options: { expectReply?: boolean; replyWithinSeconds?: number; readWithinSeconds?: number },
) {
  return (
    await tx.query(
      `insert into message_deliveries(id,canvas_id,sender_conversation_id,recipient_conversation_id,
     sender_agent_id,recipient_agent_id,origin_call_id,source_message_id,inbox_message_id,cause_id,
     expect_reply,deadline_at,unread_deadline_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
       clock_timestamp()+$12*interval '1 second',clock_timestamp()+$13*interval '1 second')
     on conflict(sender_conversation_id,source_message_id,recipient_conversation_id)
     do update set source_message_id=excluded.source_message_id returning id`,
      [
        id("delivery"),
        run.canvas_id,
        run.subject_id,
        recipient.id,
        senderId,
        recipient.agent_id,
        source.callId ?? null,
        source.messageId,
        source.inboxId,
        run.cause_id,
        options.expectReply ?? false,
        options.replyWithinSeconds ?? 120,
        options.readWithinSeconds ?? 60,
      ],
    )
  ).rows[0].id as string;
}

export async function replyAddress(sql: Sql, conversationId: string, deliveryId: string) {
  const row = (
    await sql.query(
      "select * from message_deliveries where id=$1 and recipient_conversation_id=$2",
      [deliveryId, conversationId],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(
      "MESSAGE_TARGET",
      "id 必须是当前收件箱返回的 deliveryId；复制 replyTo 地址",
      { path: "id", effect: "none" },
    );
  if (row.state !== "open")
    throw new DomainError("MESSAGE_CLOSED", "此消息已回复或关闭；新消息使用 to=agent", {
      path: "id",
      effect: "none",
    });
  return row;
}

export async function completeReply(
  tx: Tx,
  conversationId: string,
  deliveryId: string,
  callId: string,
) {
  await replyAddress(tx, conversationId, deliveryId);
  await tx.query(
    "update message_deliveries set state='replied',reply_call_id=$2,version=version+1,updated_at=now() where id=$1",
    [deliveryId, callId],
  );
}

export const deliveryFields = `q.*,q.expect_reply as "expectReply",q.deadline_at as "deadlineAt",
 q.unread_deadline_at as "unreadDeadlineAt",q.snoozed_until as "snoozedUntil",
 q.sender_conversation_id as "senderConversationId",q.recipient_conversation_id as "recipientConversationId",
 q.sender_agent_id as "senderId",q.recipient_agent_id as "recipientId",q.inbox_message_id as "messageId",
 coalesce(sender.body->>'title',m.content->>'senderName') as "senderName",
 coalesce(n.body->>'title',sent.content->'recipientNames'->>q.recipient_agent_id) as "recipientName",
 expedited.consumed_at as "expediteReadAt",m.consumed_at as "readAt",left(m.content->>'text',500) as message,
 coalesce(a.paused,false) as paused,coalesce(m.content->>'activationBlocked'='true',false) as blocked,
 (n.id is null or (m.consumed_run_id is null and m.seq<=c.consumed_message_seq)) as closed,
 (select r.state from runs r where r.subject_id=q.recipient_conversation_id order by r.created_at desc,r.id desc limit 1) as "runState"`;
export const deliveryJoins = `from message_deliveries q
 left join nodes n on n.id=q.recipient_agent_id left join nodes sender on sender.id=q.sender_agent_id
 left join agent_configs a on a.node_id=q.recipient_agent_id
 join conversations c on c.id=q.recipient_conversation_id
 left join messages m on m.conversation_id=q.recipient_conversation_id and m.client_message_id=q.inbox_message_id
 left join messages sent on sent.conversation_id=q.sender_conversation_id and sent.client_message_id=q.source_message_id
 left join messages expedited on expedited.conversation_id=q.recipient_conversation_id and expedited.client_message_id=q.expedite_message_id`;

export async function deliveries(
  sql: Sql,
  conversationId: string,
  ids?: string[],
  openOnly = false,
) {
  const rows = (
    await sql.query(
      `select ${deliveryFields} ${deliveryJoins}
    where (q.sender_conversation_id=$1 or q.recipient_conversation_id=$1)
      and ($2::text[] is null or q.id=any($2))
      and (not $3::boolean or (q.state='open' and not q.tracking_stopped and (m.consumed_at is null or q.expect_reply))) order by q.created_at,q.id`,
      [conversationId, ids ?? null, openOnly],
    )
  ).rows;
  return rows.map((q) => projectDelivery(q, conversationId));
}

/** Owner status queries may mix both directions; each delivery must appear once. */
export async function deliveryStatuses(sql: Sql, ids: string[]) {
  const rows = (
    await sql.query(
      `select ${deliveryFields} ${deliveryJoins}
      join canvases canvas on canvas.id=q.canvas_id
      where q.id=any($1::text[]) and canvas.deleted_at is null order by q.created_at,q.id`,
      [ids],
    )
  ).rows;
  return rows.map((q) => projectDelivery(q));
}

function projectDelivery(q: any, conversationId?: string) {
  return {
    ...q,
    deliveryId: q.id,
    pending: q.state === "open" && !q.tracking_stopped && (!q.readAt || q.expectReply),
    ...(q.recipientConversationId === conversationId && q.state === "open"
      ? { replyTo: { to: "reply", id: q.id } }
      : {}),
  };
}
