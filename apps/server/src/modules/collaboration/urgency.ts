import {
  assertFence,
  canvasEvent,
  DomainError,
  type Tx,
} from "../../adapters/postgres/database.js";
import { agentIdentity } from "../access/policy.js";

export const AGENT_EXPEDITE_COOLDOWN_MS = 30_000;

export async function expediteMessage(
  tx: Tx,
  conversationId: string,
  messageId: string,
  senderId?: string | null,
) {
  const message = (
    await tx.query(
      `select * from messages where conversation_id=$1 and client_message_id=$2
    and (role='user' or role='message' and content ? 'from')`,
      [conversationId, messageId],
    )
  ).rows[0];
  if (!message) throw new DomainError("NOT_FOUND", "输入不存在");
  const c = (await tx.query("select * from conversations where id=$1", [conversationId])).rows[0];
  if (message.consumed_run_id) return { state: "read", messageId };
  if (
    message.content.closed ||
    message.content.passive ||
    c.identity_kind === "deleted_agent" ||
    (!message.content.workItemId && BigInt(message.seq) <= BigInt(c.consumed_message_seq))
  )
    throw new DomainError("INVALID_STATE", "此输入已关闭");
  if (senderId) {
    const sender = await agentIdentity(tx, senderId);
    const recipient = c.agent_id ? await agentIdentity(tx, c.agent_id) : null;
    if (
      sender.canvas_id !== c.canvas_id ||
      !recipient ||
      senderId === c.agent_id ||
      (sender.config.role !== "admin" && recipient.manager_id !== senderId)
    )
      throw new DomainError("FORBIDDEN", "加急需要管理员或接收者的管理权限");
    if (message.content.activationBlocked)
      throw new DomainError("LIMIT_REACHED", "自动协作已达到上限");
  }
  const barrier = (
    await tx.query(
      `select 1 from runs r where r.subject_id=$1 and (r.reason='tool_contract_upgrade'
    or exists(select 1 from tool_calls t where t.run_id=r.id and t.state='unknown')) limit 1`,
      [conversationId],
    )
  ).rowCount;
  const run = (
    await tx.query(
      "select * from runs where subject_id=$1 and state in('queued','running','waiting') order by created_at desc limit 1",
      [conversationId],
    )
  ).rows[0];
  if (
    barrier ||
    run?.cancel_requested_at ||
    (run?.state === "waiting" &&
      !["message", "approval", "reply_required", "message_protocol", "tool_input"].includes(
        run.reason,
      ))
  )
    throw new DomainError("INVALID_STATE", "请先处理已停止的运行或未知工具结果");
  if (message.expedite_requested_at) return { state: "expediting", messageId };
  if (
    senderId &&
    c.last_agent_expedite_at &&
    Date.now() - new Date(c.last_agent_expedite_at).getTime() < AGENT_EXPEDITE_COOLDOWN_MS
  )
    throw new DomainError(
      "EXPEDITE_COOLDOWN",
      `接收者刚处理过加急，请至少等待 ${AGENT_EXPEDITE_COOLDOWN_MS / 1000} 秒`,
    );
  if (run?.state === "running") await assertFence(tx, run.id, run.epoch);
  await tx.query(
    `update messages set expedite_requested_at=now(),expedite_run_id=$3,
    content=case when $4 then content-'activationBlocked' else content end
    where conversation_id=$1 and client_message_id=$2`,
    [conversationId, messageId, run?.id ?? null, !senderId],
  );
  await tx.query(
    `update conversations set generation=generation+1,
    last_agent_expedite_at=case when $2 then now() else last_agent_expedite_at end where id=$1`,
    [conversationId, Boolean(senderId)],
  );
  if (message.content.workItemId) {
    const work = (
      await tx.query("select state,work_state from message_requests where id=$1", [
        message.content.workItemId,
      ])
    ).rows[0];
    if (work?.state !== "open" || work.work_state === "stopped")
      throw new DomainError("INVALID_STATE", "此任务已结束或停止");
    await tx.query(
      "update message_waits set state='cancelled',release_reason='expedited',released_at=now() where work_item_id=$1 and state='active'",
      [message.content.workItemId],
    );
    await tx.query(
      "update message_requests set work_state='queued',blocked_reason=null where id=$1",
      [message.content.workItemId],
    );
  }
  if (run) {
    await tx.query(
      "update runs set state='queued',reason=null,available_at=now() where id=$1 and state='waiting'",
      [run.id],
    );
    await tx.query("select pg_notify('intrica_run_wake',$1)", [run.id]);
  }
  await canvasEvent(tx, c.canvas_id, "conversation.changed", {
    conversationId,
    agentId: c.agent_id,
    messageId,
  });
  return { state: "expediting", messageId };
}
