import type { ResourceResponseReason, ResourceResponseStatus } from "@intrica/contracts";
import { canvasEvent, type Sql, type Tx } from "../../adapters/postgres/database.js";

export type Schedule = {
  id: string;
  canvas_id: string;
  agent_id: string;
  kind: "resource_change" | "cron";
  enabled: boolean;
  revision: string;
  next_due_at: Date;
  timezone: string;
  spec: Record<string, any>;
  dispatch_state: "pending" | "blocked" | "delivered" | "cancelled";
  blocked_reason: ResourceResponseReason | null;
  delivery_seq: string | null;
  delivery_run_id: string | null;
};

export async function scheduleChanged(tx: Tx, rows: Schedule[]) {
  for (const row of rows)
    await canvasEvent(tx, row.canvas_id, "conversation.changed", { agentId: row.agent_id });
}

export async function cancelResourceSchedules(
  tx: Tx,
  agentIds: string[],
  reason: "stopped" | "disabled" | "permissions_changed" = "stopped",
) {
  const { rows } = await tx.query(
    `update schedules s set enabled=false,dispatch_state='cancelled',blocked_reason=$2,revision=revision+1
     where agent_id=any($1::text[]) and kind='resource_change' and
       (dispatch_state in ('pending','blocked') or ($2<>'disabled' and dispatch_state='delivered' and not exists(
         select 1 from messages m join conversations c on c.id=m.conversation_id
         where c.agent_id=s.agent_id and m.seq=s.delivery_seq and m.consumed_run_id is not null)))
     returning s.*`,
    [agentIds, reason],
  );
  await scheduleChanged(tx, rows);
}

/** Model edits only recover live model-blocked work, never cancelled or legacy work. */
export async function recoverModelSchedules(tx: Tx, agentId?: string) {
  // Configuration edits also recover conversation inboxes. Take canvas locks
  // before touching either conversations or schedules, matching graph writes.
  const locked = await tx.query(
    `select id from canvases where deleted_at is null and id in (
       select canvas_id from schedules where dispatch_state='blocked' and blocked_reason='model_not_configured'
         and ($1::text is null or agent_id=$1)
       union select canvas_id from conversations where context->>'modelBlocked'='true'
         and ($1::text is null or agent_id=$1)) order by id for update`,
    [agentId ?? null],
  );
  const canvasIds = locked.rows.map((row) => row.id);
  if (!canvasIds.length) return;
  await tx.query(
    "update conversations set context=context-'modelBlocked' where context->>'modelBlocked'='true' and ($1::text is null or agent_id=$1) and canvas_id=any($2::text[])",
    [agentId ?? null, canvasIds],
  );
  const { rows } = await tx.query(
    `update schedules s set enabled=true,dispatch_state='pending',blocked_reason=null,
       next_due_at=clock_timestamp(),revision=s.revision+1
     from agent_configs a where a.node_id=s.agent_id and ($1::text is null or s.agent_id=$1)
       and s.canvas_id=any($2::text[]) and s.dispatch_state='blocked' and s.blocked_reason='model_not_configured'
       and ((s.kind='resource_change' and a.enabled)
         or (s.kind='cron' and a.config->'schedule'->>'enabled'='true')) returning s.*`,
    [agentId ?? null, canvasIds],
  );
  await scheduleChanged(tx, rows);
}

export async function resourceResponse(
  sql: Sql,
  agentId: string,
): Promise<ResourceResponseStatus | null> {
  const { rows } = await sql.query(
    `select s.*,a.enabled as response_enabled,m.consumed_run_id
     from schedules s join agent_configs a on a.node_id=s.agent_id
     left join conversations c on c.agent_id=s.agent_id
     left join messages m on m.conversation_id=c.id and m.seq=s.delivery_seq
     where s.agent_id=$1 and s.kind='resource_change'`,
    [agentId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    state:
      row.dispatch_state === "delivered"
        ? row.consumed_run_id
          ? "consumed"
          : "queued"
        : row.dispatch_state,
    revision: String(row.revision),
    sourceSeq: row.spec.sourceSeq ?? null,
    nextDueAt: row.enabled ? row.next_due_at.toISOString() : null,
    reason: row.blocked_reason,
    runId: row.delivery_run_id,
    canRetry: row.response_enabled && row.dispatch_state === "blocked",
  };
}
