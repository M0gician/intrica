import type { Sql, Tx } from "../../adapters/postgres/database.js";
import { actionableMessage } from "../execution/messages.js";

export const unreadCondition = (cursor: string) => `m.consumed_run_id is null
  and m.content->>'closed' is distinct from 'true'
  and (m.seq>${cursor} or m.content->>'workItemId' is not null)`;

/** Selection changes task metadata only. All tasks append to the same checkpoint. */
export async function selectWorkInput(
  sql: Sql,
  conversationId: string,
  consumed: string,
  active?: string,
) {
  const requests = (
    await sql.query(
      "select id,work_state from message_requests where recipient_conversation_id=$1 and recipient_kind<>'user' and state='open' order by created_at,id",
      [conversationId],
    )
  ).rows;
  const rows = (
    await sql.query(
      `select m.* from messages m where m.conversation_id=$1 and ${unreadCondition("$2")} and ${actionableMessage}
    order by m.seq limit 1000`,
      [conversationId, consumed],
    )
  ).rows;
  const waits = (
    await sql.query(
      "select work_item_id from message_waits where conversation_id=$1 and state='active'",
      [conversationId],
    )
  ).rows;
  const held = new Set(waits.map((w) => w.work_item_id));
  const available = requests.filter((r) => !held.has(r.id) && r.work_state !== "stopped");
  const urgent = rows.find(
    (row) => row.expedite_requested_at && available.some((r) => r.id === row.content.workItemId),
  );
  const current = available.find(
    (row) =>
      row.id === active &&
      (row.work_state === "active" ||
        (row.work_state === "waiting" &&
          rows.some((m) => !m.content.workItemId || m.content.workItemId === row.id))),
  );
  const next =
    urgent?.content.workItemId ??
    current?.id ??
    available.find((row) => ["queued", "active"].includes(row.work_state))?.id;
  return {
    ready:
      Boolean(next) || rows.some((row) => !row.content.workItemId || row.role === "tool_update"),
    workItemId: next as string | undefined,
    messages: rows
      .filter(
        (row) =>
          !row.content.workItemId || row.content.workItemId === next || row.role === "tool_update",
      )
      .slice(0, 100),
  };
}

export async function activateWork(tx: Tx, conversationId: string, workItemId?: string) {
  await tx.query(
    "update message_requests set work_state='queued' where recipient_conversation_id=$1 and recipient_kind<>'user' and state='open' and work_state='active' and id is distinct from $2",
    [conversationId, workItemId ?? null],
  );
  if (workItemId)
    await tx.query(
      "update message_requests set work_state='active',blocked_reason=null where id=$1 and state='open'",
      [workItemId],
    );
}

export async function waitForWork(
  tx: Sql,
  conversationId: string,
  workItemId: string | undefined,
  reason: string,
) {
  if (workItemId)
    await tx.query(
      "update message_requests set work_state='waiting',blocked_reason=$3 where id=$1 and recipient_conversation_id=$2 and state='open'",
      [workItemId, conversationId, reason],
    );
}

export async function unfinishedReplyReason(sql: Sql, conversationId: string) {
  if (
    (
      await sql.query(
        "select 1 from message_waits where conversation_id=$1 and state='active' limit 1",
        [conversationId],
      )
    ).rowCount
  )
    return "message";
  const pending = (
    await sql.query(
      "select 1 from message_requests where recipient_conversation_id=$1 and recipient_kind<>'user' and state='open' and work_state<>'stopped' limit 1",
      [conversationId],
    )
  ).rowCount;
  if (!pending) return null;
  const dependencies = (
    await sql.query(
      "select 1 from message_requests where sender_conversation_id=$1 and sender_kind<>'user' and state='open' limit 1",
      [conversationId],
    )
  ).rowCount;
  return dependencies ? "message" : "reply_required";
}
