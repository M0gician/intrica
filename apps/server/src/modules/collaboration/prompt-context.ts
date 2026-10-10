import type { Sql } from "../../adapters/postgres/database.js";

const limit = 40;
const page = (rows: any[]) => ({
  requests: rows.map(({ total: _total, ...request }) => request),
  total: Number(rows[0]?.total ?? 0),
  truncated: Number(rows[0]?.total ?? 0) > rows.length,
});

/** Direction and current ownership survive task selection, compaction and takeover. */
export async function messagePromptContext(sql: Sql, conversationId: string, workItemId?: string) {
  const incoming = await sql.query(
    `select id,state,work_state as "workState",reply_message_id as "replyMessageId",
    blocked_reason as "blockedReason",sender_kind as "senderKind",sender_agent_id as "senderAgentId",
    sender_conversation_id as "senderConversationId",origin_work_item_id as "originWorkItemId",
    count(*) over() as total
    from message_requests where recipient_conversation_id=$1 and recipient_kind<>'user' and state='open'
    order by (id=$2) desc,created_at,id limit $3`,
    [conversationId, workItemId ?? null, limit],
  );
  const outgoing = await sql.query(
    `select r.id,r.state,r.work_state as "workState",r.reply_message_id as "replyMessageId",
    r.blocked_reason as "blockedReason",r.origin_work_item_id as "originWorkItemId",
    r.recipient_kind as "recipientKind",r.recipient_agent_id as "recipientAgentId",
    r.recipient_conversation_id as "recipientConversationId",r.lifetime,
    r.followup_count as "followupCount",
    (case when r.origin_work_item_id is null then r.sender_conversation_id else
      (select p.recipient_conversation_id from message_requests p where p.id=r.origin_work_item_id)
    end=$1) as "controlsFollowup",count(*) over() as total
    from message_requests r where r.sender_kind<>'user' and (
      r.sender_conversation_id=$1 or exists(
        select 1 from request_dependencies d join message_requests p on p.id=d.parent_id
        where d.child_id=r.id and d.released_at is null and p.recipient_conversation_id=$1
        and p.state='open' and p.work_state<>'stopped'))
    and (r.state='open' or r.origin_work_item_id=$2 or exists(
      select 1 from request_dependencies d where d.child_id=r.id and d.parent_id=$2 and d.released_at is null))
    order by (r.origin_work_item_id=$2 or exists(
      select 1 from request_dependencies d where d.child_id=r.id and d.parent_id=$2 and d.released_at is null))
    desc nulls last,r.updated_at desc,r.id limit $3`,
    [conversationId, workItemId ?? null, limit],
  );
  return { incoming: page(incoming.rows), outgoing: page(outgoing.rows) };
}
