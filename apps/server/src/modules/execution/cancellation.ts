import { canvasEvent, type Tx } from "../../adapters/postgres/database.js";
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
    where status='pending' and origin_call_id in(select id from tool_calls where run_id=any($1::text[])) returning *`,
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
  if (resourceReason === "stopped") {
    await tx.query("update agent_configs set paused=true where node_id=any($1::text[])", [
      agentIds,
    ]);
  }
  // Cancellation never consumes an unread input. A later run must still receive it.
  await tx.query(
    `update messages m set run_id=null,expedite_run_id=null from conversations c
    where c.id=m.conversation_id and c.agent_id=any($1::text[]) and m.seq>c.consumed_message_seq
    and m.consumed_run_id is null and m.role in('message','message_notice','team_notice','user')`,
    [agentIds],
  );
  const rows = (
    await tx.query(
      `update runs set cancel_requested_at=now(),state=case when state='running' then state else 'cancelled' end,reason=${cancellationReason},updated_at=now()
    where subject_id in(select id from conversations where agent_id=any($1::text[])) and state in('queued','running','waiting') returning *`,
      [agentIds],
    )
  ).rows;
  for (const c of (
    await tx.query(
      "select id,canvas_id,agent_id from conversations where agent_id=any($1::text[])",
      [agentIds],
    )
  ).rows)
    await canvasEvent(tx, c.canvas_id, "conversation.changed", {
      conversationId: c.id,
      agentId: c.agent_id,
    });
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
