import {
  assertFence,
  canvasEvent,
  type Database,
  DomainError,
} from "../../adapters/postgres/database.js";

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
  return db.canvas(conversation.canvas_id, async (tx) => {
    const message = (
      await tx.query(
        "select * from messages where conversation_id=$1 and client_message_id=$2 and role='user' for update",
        [conversationId, messageId],
      )
    ).rows[0];
    if (!message) throw new DomainError("NOT_FOUND", "输入不存在");
    if (message.consumed_run_id) return { state: "read", messageId };
    const c = (
      await tx.query("select consumed_message_seq from conversations where id=$1", [conversationId])
    ).rows[0];
    if (
      message.content.closed ||
      (!message.content.workItemId && BigInt(message.seq) <= BigInt(c.consumed_message_seq))
    )
      throw new DomainError("INVALID_STATE", "此输入已因上下文重置而关闭");
    const run = (
      await tx.query(
        "select * from runs where subject_id=$1 and state in('queued','running','waiting') and cancel_requested_at is null order by created_at desc limit 1",
        [conversationId],
      )
    ).rows[0];
    if (!run || run.reason === "tool_contract_upgrade" || run.reason === "unknown")
      throw new DomainError("INVALID_STATE", "Agent 已停止或需要先核实工具结果");
    if (run.state === "running") await assertFence(tx, run.id, run.epoch);
    const changed = await tx.query(
      "update messages set expedite_requested_at=coalesce(expedite_requested_at,now()),expedite_run_id=$3 where conversation_id=$1 and client_message_id=$2 and expedite_run_id is distinct from $3 returning seq",
      [conversationId, messageId, run.id],
    );
    if (changed.rowCount)
      await tx.query("update conversations set generation=generation+1 where id=$1", [
        conversationId,
      ]);
    await tx.query(
      "update runs set state='queued',reason=null,available_at=now() where id=$1 and state='waiting' and reason in('approval','message','reply_required','message_protocol')",
      [run.id],
    );
    await tx.query("select pg_notify('intrica_run_wake',$1)", [run.id]);
    await canvasEvent(tx, conversation.canvas_id, "conversation.changed", {
      conversationId,
      agentId: conversation.agent_id,
      messageId,
    });
    return { state: "expediting", messageId };
  });
}
export async function projectInputReceipts(db: Database, records: any[], conversationId: string) {
  const ids = records.filter((r) => r.role === "user").map((r) => r.seq);
  if (!ids.length) return records;
  const rows = (
    await db.pool.query(
      `select m.seq,m.client_message_id,m.consumed_run_id,m.consumed_at,m.expedite_requested_at,
    case when m.consumed_run_id is not null then 'read' when m.content->>'closed'='true' or (m.content->>'workItemId' is null and m.seq<=c.consumed_message_seq) then 'closed'
      when r.state in('cancelled','failed') or r.cancel_requested_at is not null then 'stopped'
      when m.expedite_requested_at is not null and m.expedite_run_id=r.id then 'expediting' else 'unread' end as state
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
      },
    ]),
  );
  for (const record of records)
    if (record.role === "user")
      record.content = { ...record.content, inputReceipt: receipts.get(String(record.seq)) };
  return records;
}
