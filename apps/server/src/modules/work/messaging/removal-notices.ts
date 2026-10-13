import { canvasEvent } from "../../../adapters/postgres/database.js";
import { type MessagingContext, wakeInbox } from "./context.js";

const pendingRemoval = `m.role='team_notice' and m.content->>'event'='member_removed'
  and not(m.content ? 'activationBlocked') and m.seq>c.consumed_message_seq`;

/** Graph deletion records notices; the normal inbox admission enforces pause and budgets. */
export async function wakeRemovalNotices(context: MessagingContext) {
  const pending = (
    await context.db.pool.query(
      `select distinct c.canvas_id,c.id,m.content->>'causeId' as cause_id
    from messages m join conversations c on c.id=m.conversation_id
    join canvases board on board.id=c.canvas_id and board.deleted_at is null
    left join runs r on r.id=m.run_id
    where ${pendingRemoval}
    and (m.run_id is null or r.state='waiting' and r.reason in('message','approval','inbox_review')) limit 64`,
    )
  ).rows;
  for (const inbox of pending)
    await context.db.canvas(inbox.canvas_id, async (tx) => {
      if (!inbox.cause_id) return;
      const current = await tx.query(
        `select m.seq from messages m join conversations c on c.id=m.conversation_id
        where c.id=$1 and m.content->>'causeId'=$2 and ${pendingRemoval}`,
        [inbox.id, inbox.cause_id],
      );
      if (!current.rowCount) return;
      const blocked = await wakeInbox(context, tx, inbox.id, inbox.cause_id);
      if (blocked === "LIMIT_REACHED") {
        await tx.query(
          "update messages set content=content||'{\"activationBlocked\":true}'::jsonb where conversation_id=$1 and seq=any($2::bigint[])",
          [inbox.id, current.rows.map((m) => m.seq)],
        );
        await canvasEvent(tx, inbox.canvas_id, "conversation.changed", {
          conversationId: inbox.id,
        });
      }
    });
}
