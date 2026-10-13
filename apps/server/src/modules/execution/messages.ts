import { canvasEvent, type Tx } from "../../adapters/postgres/database.js";

/** Update the existing tool receipt; approvals do not create a second execution. */
export async function projectToolOutcome(tx: Tx, callId: string) {
  const rows = await tx.query(
    `update messages m set content=m.content||jsonb_build_object(
    'status',case t.state when 'succeeded' then 'complete' else 'error' end,'result',t.result)
    from tool_calls t where t.id=$1 and t.state in('succeeded','failed') and m.role='tool'
    and m.content->>'callId'=t.id returning m.conversation_id`,
    [callId],
  );
  if (rows.rowCount) {
    const run = (
      await tx.query(
        "select r.canvas_id,r.subject_id from runs r join tool_calls t on t.run_id=r.id where t.id=$1",
        [callId],
      )
    ).rows[0];
    await canvasEvent(tx, run.canvas_id, "conversation.changed", {
      conversationId: run.subject_id,
    });
  }
}

/** Immutable labels for history; `from` remains reserved for inbox messages. */
export async function collaborationIdentity(
  tx: Tx,
  canvasId: string,
  senderId: string | null,
  recipients: string[],
) {
  const names = new Map<string, string>(
    (
      await tx.query(
        "select id,body->>'title' as title from nodes where canvas_id=$1 and id=any($2::text[])",
        [canvasId, [...recipients, ...(senderId ? [senderId] : [])]],
      )
    ).rows.map((n) => [n.id, n.title]),
  );
  return {
    senderId: senderId ?? "workspace",
    senderName: senderId ? (names.get(senderId) ?? "") : "",
    recipientNames: Object.fromEntries(recipients.map((id) => [id, names.get(id) ?? ""])),
  };
}

// All consumers use the same eligibility rules. Historical notices remain visible
// in the transcript, but may no longer wake inference or request a decision.
export const currentTeamNotice = `(m.role='team_notice' and not(m.content ? 'activationBlocked') and (
  m.content->>'event'='member_removed' or exists(
  select 1 from runs source join conversations member on member.id=source.subject_id
  join nodes n on n.id=member.agent_id join conversations manager on manager.agent_id=n.parent_id
  where source.id=m.content->>'runId' and source.epoch::text=m.content->>'epoch'
  and source.state=m.content->>'state' and manager.id=m.conversation_id
  and (source.state='failed' or source.reason=m.content->>'category')
  and source.superseded_by_run_id is null
  and not exists(select 1 from runs newer where newer.subject_id=source.subject_id
    and (newer.created_at,newer.id)>(source.created_at,source.id))
)))`;

export const actionableMessage = `(
  m.role in ('user','trigger','completion_review')
  or (m.role='message_notice' and not(m.content ? 'activationBlocked') and exists(
    select 1 from jsonb_array_elements(coalesce(m.content->'deliveries','[]')) reminder
    join message_deliveries q on q.id=reminder->>'deliveryId'
    where q.state='open' and not q.tracking_stopped and q.version::text=reminder->>'version'
    and (reminder->>'event'='reply_overdue' and q.expect_reply or reminder->>'event'='unread' and exists(
      select 1 from messages receipt join conversations inbox on inbox.id=receipt.conversation_id
      where receipt.conversation_id=q.recipient_conversation_id and receipt.client_message_id=q.inbox_message_id
      and receipt.consumed_run_id is null and receipt.seq>inbox.consumed_message_seq))))
  or (m.role='message' and m.content ? 'from' and m.run_id is not null and not(m.content ? 'activationBlocked'))
  or (${currentTeamNotice} and m.run_id is not null)
  or (m.role='tool_update' and m.content->>'progress' is distinct from 'true')
  or (m.role='tool_update' and m.content->>'reviewRequired'='true')
  or (m.role='permission_notice' and exists(
    select 1 from approvals a join conversations inbox on inbox.id=m.conversation_id
    where a.id=m.content->>'requestId' and a.status='pending'
    and a.assigned_reviewer_id=inbox.agent_id
    and m.client_message_id='approval-'||a.id||'-'||a.version::text
  ))
)`;

export const pendingInboxMessage = `((m.role='message' and m.content ? 'from' and not(m.content ? 'activationBlocked'))
  or (m.role='message_notice' and ${actionableMessage})
  or ${currentTeamNotice}
  or (m.role='permission_notice' and ${actionableMessage}))`;

/** Durable inbox append; caller holds the canvas transaction. */
export async function appendMessage(
  tx: Tx,
  conversationId: string,
  key: string,
  role: string,
  content: unknown,
  runId?: string,
) {
  const prior = (
    await tx.query("select seq from messages where conversation_id=$1 and client_message_id=$2", [
      conversationId,
      key,
    ])
  ).rows[0];
  if (prior) return String(prior.seq);
  const seq = String(
    (
      await tx.query(
        "update conversations set message_seq=message_seq+1 where id=$1 returning message_seq",
        [conversationId],
      )
    ).rows[0].message_seq,
  );
  await tx.query(
    "insert into messages(conversation_id,seq,client_message_id,role,content,run_id) values($1,$2,$3,$4,$5,$6)",
    [conversationId, seq, key, role, JSON.stringify(content), runId ?? null],
  );
  return seq;
}
