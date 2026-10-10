import type { Sql } from "../../adapters/postgres/database.js";
import { followupLimit } from "./followups.js";

export async function waitSnapshot(sql: Sql, wait: any) {
  const requests = (
    await sql.query(
      `select r.id,r.state,r.work_state as "workState",
    r.blocked_reason as "blockedReason",r.followup_count as "followupCount",
    r.recipient_agent_id as "recipientAgentId",n.body->>'title' as "recipientName",
    extract(epoch from(now()-r.created_at))::int as "elapsedSeconds",
    m.created_at as "deliveredAt",m.consumed_at as "consumedAt",m.expedite_requested_at as "expeditedAt",
    case when m.consumed_at is not null then 'read' when m.content->>'closed'='true' then 'closed'
      when m.content->>'activationBlocked'='true' then 'blocked' else 'unread' end as receipt,
    (select jsonb_build_object('kind',p.content->>'messageKind','at',p.created_at)
      from messages p where p.conversation_id=r.sender_conversation_id and p.content->>'inReplyTo'=r.id
      order by p.seq desc limit 1) as progress
    from message_requests r left join nodes n on n.id=r.recipient_agent_id
    left join messages m on m.conversation_id=r.recipient_conversation_id and m.content->>'collaborationRequestId'=r.id
      and m.content->>'messageId'=r.message_id
    where r.id=any($1::text[]) order by r.created_at,r.id`,
      [wait.request_ids],
    )
  ).rows;
  return {
    waitId: wait.id,
    mode: wait.mode,
    workItemId: wait.work_item_id,
    deadline: wait.deadline,
    waitedSeconds: Math.max(
      0,
      Math.floor((Date.now() - new Date(wait.created_at).getTime()) / 1000),
    ),
    requests,
    followupLimit: followupLimit(),
    instruction:
      "This server notice is not a message from a user or Agent. No reminder was sent and no request was closed. Decide whether to wait again, send an allowed followup, expedite with permission, or report blocked. Never replay a tool with an unknown outcome.",
  };
}

export async function listWaits(sql: Sql, conversationId: string) {
  const rows = (
    await sql.query(
      `select * from message_waits where conversation_id=$1 and state='active'
    order by created_at,id`,
      [conversationId],
    )
  ).rows;
  return Promise.all(
    rows.map(async (row) => ({
      ...(await waitSnapshot(sql, row)),
      state: row.state,
      blockedReason: row.blocked_reason,
    })),
  );
}
