import { canvasEvent, type Tx } from "../../adapters/postgres/database.js";
import { releaseDependencies } from "./request-lifecycle.js";
import { cancelResourceSchedules } from "./schedules.js";
import { result } from "./tool-calls.js";

// The upgrade reason is an execution barrier and survives a stop.
export const cancellationReason =
  "case when state='running' or reason='tool_contract_upgrade' then reason else '已停止' end";

/** Cancel permissions before stopping a run, so a late decision cannot revive it. */
export async function cancelApprovals(tx: Tx, runIds: string[]) {
  const rows = (
    await tx.query(
      `update approvals set status='cancelled',version=version+1,decided_at=now()
    where status='pending' and (origin_call_id in(select id from tool_calls where run_id=any($1::text[])) or origin_dispatch_id in(select id from message_dispatches where run_id=any($1::text[]))) returning *`,
      [runIds],
    )
  ).rows;
  for (const r of rows) {
    await tx.query(
      "update tool_calls set state='failed',result=$2,delivered_at=null where id=$1 and state in('prepared','waiting')",
      [
        r.origin_call_id,
        JSON.stringify({ ...result({ status: "cancelled", requestId: r.id }), isError: true }),
      ],
    );
    await canvasEvent(tx, r.canvas_id, "approval.changed", {
      id: r.id,
      agentId: r.subject_id,
      status: "cancelled",
    });
  }
}
export async function cancelAgents(
  tx: Tx,
  agentIds: string[],
  resourceReason: "stopped" | "permissions_changed" = "stopped",
) {
  await cancelResourceSchedules(tx, agentIds, resourceReason);
  const conversations = (
    await tx.query("select id from conversations where agent_id=any($1::text[])", [agentIds])
  ).rows;
  await stopConversationInputs(
    tx,
    conversations.map((c) => c.id),
    resourceReason,
  );

  await tx.query(
    "update conversations c set consumed_message_seq=message_seq,context=context-'modelBlocked' where agent_id=any($1::text[]) and not exists(select 1 from runs r where r.subject_id=c.id and r.reason='tool_contract_upgrade')",
    [agentIds],
  );
  const rows = (
    await tx.query(
      `update runs set cancel_requested_at=now(),state=case when state='running' then state else 'cancelled' end,reason=${cancellationReason},updated_at=now()
    where subject_id in(select id from conversations where agent_id=any($1::text[])) and state in('queued','running','waiting') returning *`,
      [agentIds],
    )
  ).rows;
  await cancelApprovals(
    tx,
    rows.map((r) => r.id),
  );
  for (const r of rows)
    await canvasEvent(tx, r.canvas_id, "run.changed", {
      id: r.id,
      state: r.state,
      cancelRequested: true,
      subjectId: r.subject_id,
      kind: r.kind,
    });
}

export async function stopConversationInputs(
  tx: Tx,
  conversationIds: string[],
  reason = "stopped",
) {
  const parents = (
    await tx.query(
      "select id from message_requests where recipient_conversation_id=any($1::text[]) and state='open'",
      [conversationIds],
    )
  ).rows;
  await releaseDependencies(
    tx,
    parents.map((r) => r.id),
    reason,
  );
  await tx.query(
    "update message_waits set state='cancelled',release_reason=$2,released_at=now() where conversation_id=any($1::text[]) and state='active'",
    [conversationIds, reason],
  );
  await tx.query("update conversations set generation=generation+1 where id=any($1::text[])", [
    conversationIds,
  ]);
  await tx.query(
    `update messages m set content=content||'{"closed":true}'::jsonb
    from conversations c where c.id=m.conversation_id and c.id=any($1::text[]) and m.consumed_run_id is null`,
    [conversationIds],
  );
  await tx.query(
    `update message_requests set work_state='stopped',blocked_reason=$2 where recipient_conversation_id=any($1::text[]) and state='open'`,
    [conversationIds, reason],
  );
  await tx.query(
    `update message_dispatches d set state='cancelled',updated_at=now() from conversations c
    where c.id=d.conversation_id and c.id=any($1::text[]) and d.state in('prepared','waiting')`,
    [conversationIds],
  );
}
