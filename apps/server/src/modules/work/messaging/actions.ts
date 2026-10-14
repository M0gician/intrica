import { canvasEvent, DomainError, type Tx } from "../../../adapters/postgres/database.js";
import { agentIdentity, collaborationNeedsApproval } from "../../access/policy.js";
import { collaborationIdentity } from "../../execution/messages.js";
import { type MessagingContext, wakeInbox } from "./context.js";
import { deliveries } from "./deliveries.js";

export async function updateDelivery(
  context: MessagingContext,
  tx: Tx,
  conversationId: string,
  deliveryId: string,
  action: "wait" | "expedite" | "cancel",
  seconds = 120,
  version?: number,
) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 604800)
    throw new DomainError("MESSAGE_INPUT", "waitSeconds 必须是 1–604800 的整数", {
      path: "waitSeconds",
    });
  const q = (
    await tx.query(
      "select * from message_deliveries where id=$1 and sender_conversation_id=$2 for update",
      [deliveryId, conversationId],
    )
  ).rows[0];
  if (!q) throw new DomainError("FORBIDDEN", "只能跟踪自己发送的消息");
  const status = (await deliveries(tx, conversationId, [deliveryId])).find((d) => d.id === q.id)!;
  if (version !== undefined && q.version !== version)
    throw new DomainError("VERSION_CONFLICT", "消息状态已变化；按当前回执重新决定操作", {
      effect: "none",
      version: q.version,
      receipt: status,
      allowedActions: !status.pending
        ? []
        : status.closed
          ? ["cancel"]
          : status.paused || status.blocked
            ? ["wait", "cancel"]
            : ["wait", "expedite", "cancel"],
    });
  if (!status.pending) return { deliveryId, status: q.state, changed: false };
  if (status.closed && action !== "cancel")
    throw new DomainError("RECIPIENT_REMOVED", "接收者已移除；核查结果并重新分配工作后停止跟踪", {
      effect: "none",
      receipt: status,
      allowedActions: ["cancel"],
    });
  if (action === "expedite") {
    if (status.blocked)
      throw new DomainError("MESSAGE_BLOCKED", "消息达到自动协作上限；需要用户恢复任务后再处理", {
        effect: "none",
      });
    const target = await agentIdentity(tx, q.recipient_agent_id);
    if (
      target.canvas_id !== q.canvas_id ||
      (q.sender_agent_id &&
        (await collaborationNeedsApproval(tx, q.sender_agent_id, q.recipient_agent_id, false)))
    )
      throw new DomainError("FORBIDDEN", "通信范围已变化；重新使用 send_message 发送可审查的消息");
    const latest = (
      await tx.query(
        "select * from runs where subject_id=$1 order by created_at desc,id desc limit 1",
        [q.recipient_conversation_id],
      )
    ).rows[0];
    if (status.paused || latest?.state === "cancelled" || latest?.cancel_requested_at)
      throw new DomainError("RECIPIENT_STOPPED", "接收者已暂停；恢复协作后才能加急");
    if (
      (
        await tx.query(
          "select 1 from message_deliveries where recipient_conversation_id=$1 and expedited_at>clock_timestamp()-interval '30 seconds' limit 1",
          [q.recipient_conversation_id],
        )
      ).rowCount
    )
      throw new DomainError("EXPEDITE_COOLDOWN", "此接收者刚收到加急，30 秒后可重试", {
        retryAfterSeconds: 30,
      });
    const active =
      latest && ["running", "queued", "waiting"].includes(latest.state) ? latest : undefined;
    const messageId = `followup-${q.id}-${q.version}`;
    await context.conversations.append(
      tx,
      q.recipient_conversation_id,
      messageId,
      "message",
      {
        ...(await collaborationIdentity(tx, q.canvas_id, q.sender_agent_id, [
          q.recipient_agent_id,
        ])),
        from: q.sender_agent_id ?? "workspace",
        text: `请优先处理原消息：${status.message}`,
        deliveryId: q.id,
        priority: "expedited",
        replyTo: { to: "reply", id: q.id },
        causeId: q.cause_id,
        language: await context.conversations.language(conversationId, tx),
      },
      active?.id,
    );
    await tx.query(
      "update messages set expedite_requested_at=now(),expedite_run_id=$3 where conversation_id=$1 and client_message_id=$2",
      [q.recipient_conversation_id, messageId, active?.id ?? null],
    );
    await tx.query(
      "update message_deliveries set expedited_at=clock_timestamp(),expedited_by=$2,expedite_message_id=$3 where id=$1",
      [q.id, q.sender_agent_id ?? "owner", messageId],
    );
    await wakeInbox(context, tx, q.recipient_conversation_id, q.cause_id);
  }
  const row = (
    await tx.query(
      `update message_deliveries set tracking_stopped=$2,
    snoozed_until=clock_timestamp()+$3*interval '1 second',notified_at=null,unread_notified_at=null,
    version=version+1,updated_at=now() where id=$1 returning *`,
      [q.id, action === "cancel", seconds],
    )
  ).rows[0];
  await canvasEvent(tx, q.canvas_id, "conversation.changed", {
    conversationId,
    recipients: [q.recipient_agent_id],
  });
  return {
    deliveryId: q.id,
    status: row.state,
    tracking: !row.tracking_stopped,
    action,
    deadlineAt: row.deadline_at,
    unreadDeadlineAt: row.unread_deadline_at,
    nextReminderAt: row.snoozed_until,
    version: row.version,
  };
}
