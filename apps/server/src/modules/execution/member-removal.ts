import { canvasEvent, id, type Tx } from "../../adapters/postgres/database.js";
import { appendMessage } from "./messages.js";

/** Preserve unfinished handoffs before deleting the member's directory entry. */
export async function notifyMemberRemoval(tx: Tx, canvasId: string, nodeIds: string[]) {
  const members = (
    await tx.query(
      `select n.id,n.body->>'title' as title,manager.id as manager_conversation_id,
      (select cause_id from runs where subject_id=c.id order by created_at desc,id desc limit 1) as cause_id
    from nodes n join conversations c on c.agent_id=n.id
    left join conversations manager on manager.agent_id=n.parent_id and not(manager.agent_id=any($2::text[]))
    where n.canvas_id=$1 and n.id=any($2::text[])`,
      [canvasId, nodeIds],
    )
  ).rows;
  for (const member of members) {
    const pending = (
      await tx.query(
        `select q.id,q.sender_conversation_id,q.cause_id from message_deliveries q
      join conversations c on c.id=q.sender_conversation_id
      left join messages m on m.conversation_id=q.recipient_conversation_id and m.client_message_id=q.inbox_message_id
      where q.recipient_agent_id=$1 and q.state='open' and not q.tracking_stopped
      and (q.expect_reply or m.consumed_at is null) and (c.agent_id is null or not(c.agent_id=any($2::text[])))`,
        [member.id, nodeIds],
      )
    ).rows;
    const recipients = new Set<string>(pending.map((q) => q.sender_conversation_id));
    if (member.manager_conversation_id) recipients.add(member.manager_conversation_id);
    for (const recipient of recipients) {
      const requests = pending.filter((q) => q.sender_conversation_id === recipient);
      const active = (
        await tx.query(
          "select id,cause_id from runs where subject_id=$1 and state in('running','queued','waiting') and cancel_requested_at is null",
          [recipient],
        )
      ).rows[0];
      await appendMessage(
        tx,
        recipient,
        `member-removed-${member.id}-${id("notice")}`,
        "team_notice",
        {
          event: "member_removed",
          agentId: member.id,
          agentName: member.title,
          deliveryIds: requests.map((q) => q.id),
          causeId: requests[0]?.cause_id ?? member.cause_id ?? active?.cause_id,
          text: `成员 ${member.title} 已移除。其未完成事项不会自动视为完成；请核查已交付结果，重新分配剩余工作或说明取消原因。`,
        },
        active?.id,
      );
      await canvasEvent(tx, canvasId, "conversation.changed", { conversationId: recipient });
      if (active) await tx.query("select pg_notify('intrica_run_wake',$1)", [active.id]);
    }
  }
}
