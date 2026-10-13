import { canvasEvent, digest } from "../../../adapters/postgres/database.js";
import { type MessagingContext, wakeInbox } from "./context.js";
import { deliveries } from "./deliveries.js";

const due = `q.state='open' and not q.tracking_stopped
 and (q.snoozed_until is null or q.snoozed_until<=clock_timestamp())
 and ((q.expect_reply and q.notified_at is null and q.deadline_at<=clock_timestamp())
   or (q.unread_notified_at is null and q.unread_deadline_at<=clock_timestamp() and exists(
     select 1 from messages m join conversations c on c.id=m.conversation_id
     where m.conversation_id=q.recipient_conversation_id and m.client_message_id=q.inbox_message_id
     and m.consumed_run_id is null and m.seq>c.consumed_message_seq)))`;

export async function tickReminders(context: MessagingContext) {
  const candidates = (
    await context.db.pool.query(`select q.id,q.canvas_id,q.sender_conversation_id,q.cause_id
    from message_deliveries q join canvases c on c.id=q.canvas_id where c.deleted_at is null and ${due}
    order by least(q.deadline_at,q.unread_deadline_at),q.id limit 64`)
  ).rows;
  const groups = new Map<string, typeof candidates>();
  for (const q of candidates) {
    const key = `${q.sender_conversation_id}:${q.cause_id}`;
    groups.set(key, [...(groups.get(key) ?? []), q]);
  }
  for (const group of groups.values())
    await context.db.canvas(group[0].canvas_id, async (tx) => {
      const rows = (
        await tx.query(
          `select q.*,clock_timestamp() as clock from message_deliveries q
      where q.id=any($1::text[]) and ${due} order by q.id for update`,
          [group.map((q) => q.id)],
        )
      ).rows;
      if (!rows.length) return;
      const first = rows[0],
        sender = first.sender_conversation_id;
      const statuses = await deliveries(
        tx,
        sender,
        rows.map((q) => q.id),
      );
      const entries = [];
      for (const q of rows) {
        const status = statuses.find((d) => d.id === q.id)!;
        if (!status.pending) {
          if (status.closed)
            await tx.query("update message_deliveries set tracking_stopped=true where id=$1", [
              q.id,
            ]);
          continue;
        }
        const unread = !status.readAt && !q.unread_notified_at && q.unread_deadline_at <= q.clock;
        const reply = q.expect_reply && !q.notified_at && q.deadline_at <= q.clock;
        if (!unread && !reply) continue;
        entries.push({
          deliveryId: q.id,
          version: q.version,
          event: reply ? "reply_overdue" : "unread",
          recipientId: q.recipient_agent_id,
          recipientName: status.recipientName,
          readAt: status.readAt,
          runState: status.runState,
          expectReply: q.expect_reply,
        });
        await tx.query(
          `update message_deliveries set notified_at=case when $2 then now() else notified_at end,
        unread_notified_at=case when $3 then now() else unread_notified_at end,notice_count=notice_count+1 where id=$1`,
          [q.id, reply, unread],
        );
      }
      if (!entries.length) return;
      const language = await context.conversations.language(sender, tx);
      const latest = (
        await tx.query(
          "select * from runs where subject_id=$1 order by created_at desc,id desc limit 1",
          [sender],
        )
      ).rows[0];
      const active =
        latest &&
        ["queued", "running", "waiting"].includes(latest.state) &&
        !latest.cancel_requested_at
          ? latest
          : undefined;
      const key = `message-reminder-${digest(entries.map((e) => [e.deliveryId, e.version, e.event]))}`;
      await context.conversations.append(
        tx,
        sender,
        key,
        "message_notice",
        {
          event: "message_deadlines",
          deliveries: entries,
          hook: "update_message",
          actions: ["wait", "expedite", "cancel"],
          text:
            language === "zh-CN"
              ? `${entries.length} 条协作消息需要跟进：${entries.filter((e) => e.event === "unread").length} 条未读超时，${entries.filter((e) => e.event === "reply_overdue").length} 条回复超时。请选择继续等待、加急或停止跟踪。`
              : `${entries.length} collaboration messages need follow-up. ${entries.filter((e) => e.event === "unread").length} unread deadlines and ${entries.filter((e) => e.event === "reply_overdue").length} reply deadlines. Wait, expedite or stop tracking.`,
          language,
          causeId: first.cause_id,
          ...(active?.state === "running" ? { priority: "expedited" } : {}),
        },
        active?.id,
      );
      if (active?.state === "running")
        await tx.query(
          "update messages set expedite_requested_at=now(),expedite_run_id=$3 where conversation_id=$1 and client_message_id=$2",
          [sender, key, active.id],
        );
      await wakeInbox(context, tx, sender, first.cause_id);
      await canvasEvent(tx, first.canvas_id, "conversation.changed", { conversationId: sender });
    });
}
