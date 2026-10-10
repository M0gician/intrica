import type { ApprovalPage, ApprovalRecord, EffectiveAgentPermissions } from "@intrica/contracts";
import type { Database } from "../../adapters/postgres/database.js";
import { canApprove, intentSummary } from "./intents.js";
import { type Actor, agentIdentity, grantsFor, OWNER } from "./policy.js";
export async function describePermissions(
  db: Database,
  agentId: string,
): Promise<EffectiveAgentPermissions> {
  const identity = await agentIdentity(db.pool, agentId);
  const grants = await grantsFor(db.pool, agentId);
  const names = new Map(
    (
      await db.pool.query("select id,body->>'title' as title from nodes where id=any($1::text[])", [
        grants.slice(0, 200).map((grant) => grant.resource_id),
      ])
    ).rows.map((row) => [row.id, row.title]),
  );
  return {
    role: identity.config.role,
    permissionProtocol: 2,
    commandExecution:
      identity.config.role === "admin" || grants.some((g) => g.execution_mode === "host")
        ? "host"
        : "isolated",
    resources: grants.slice(0, 200).map((grant) => ({
      nodeId: grant.resource_id,
      rootId: grant.root_resource_id,
      title: names.get(grant.resource_id) || grant.resource_id,
      mode: grant.mode,
      execution: grant.execution_mode,
      sourceLinkId: grant.source_link_id,
      delegatedBy: grant.delegated_by ?? null,
    })),
    totalResources: grants.length,
  };
}

export async function listApprovals(
  db: Database,
  canvasId: string,
  options: {
    subjectId?: string;
    status?: string;
    cursor?: string;
    limit?: number;
    actor?: Actor;
    requestIds?: string[];
    participantId?: string;
  } = {},
): Promise<ApprovalPage> {
  const actor = options.actor ?? OWNER;
  const values = [
    canvasId,
    options.subjectId ?? null,
    options.status ?? null,
    actor.kind === "agent" ? actor.agentId : null,
    options.requestIds ?? null,
    options.participantId ?? null,
  ];
  const filter =
    "canvas_id=$1 and ($2::text is null or subject_id=$2) and ($3::text is null or status=$3) and ($4::text is null or subject_id=$4 or assigned_reviewer_id=$4) and ($5::text[] is null or id=any($5)) and ($6::text is null or subject_id=$6 or assigned_reviewer_id=$6)";
  const total = (
    await db.pool.query(`select count(*)::int as n from approvals where ${filter}`, values)
  ).rows[0].n;
  const limit = Math.min(100, options.limit ?? 40);
  const rows = (
    await db.pool.query(
      `select a.*,coalesce((select state from tool_calls where id=a.origin_call_id),(select state from message_dispatches where id=a.origin_dispatch_id)) as execution_state from approvals a where ${filter} and ($7::text is null or (created_at,id)<(select created_at,id from approvals where id=$7)) order by created_at desc,id desc limit $8`,
      [...values, options.cursor ?? null, limit + 1],
    )
  ).rows;
  const requests: ApprovalRecord[] = await Promise.all(
    rows.slice(0, limit).map(async (r) => {
      const approvable =
        actor.kind === "owner" ||
        (await canApprove(db.pool, actor.agentId, r.subject_id, r.action));
      const summary = intentSummary(r.action, r.basis);
      const ids = [
        r.subject_id,
        r.assigned_reviewer_id,
        ...(summary.recipients ?? []),
        ...(approvable ? (summary.resourceIds ?? []) : []),
      ].filter(Boolean);
      const names = Object.fromEntries(
        (
          await db.pool.query(
            "select id,body->>'title' as title from nodes where canvas_id=$1 and id=any($2::text[])",
            [canvasId, ids],
          )
        ).rows.map((n) => [n.id, n.title]),
      );
      return {
        id: r.id,
        agentId: r.subject_id,
        toolCallId: r.origin_call_id,
        status: r.status,
        version: r.version,
        reviewerId: r.assigned_reviewer_id,
        decidedBy: r.decided_by,
        reason: actor.kind === "owner" ? r.reason : "",
        decisionReason: actor.kind === "owner" ? r.decision : null,
        routeReason: r.route_reason,
        kind: r.action.kind,
        scope: ["host", "agent", "collaboration"].includes(r.action.kind) ? "once" : "persistent",
        summary,
        names,
        ...(!approvable && actor.kind === "agent" && r.assigned_reviewer_id === actor.agentId
          ? { blockedReason: "outside_authority" }
          : {}),
        ...(actor.kind === "owner" ||
        r.subject_id === actor.agentId ||
        (r.assigned_reviewer_id === actor.agentId && approvable)
          ? { action: r.action }
          : {}),
        expiresAt: new Date(r.expires_at).toISOString(),
        reviewDueAt: r.review_due_at ? new Date(r.review_due_at).toISOString() : null,
        allowedActions:
          r.status === "pending"
            ? actor.kind === "owner"
              ? ["approve", "deny", ...(r.assigned_reviewer_id ? ["escalate" as const] : [])]
              : r.assigned_reviewer_id === actor.agentId
                ? [...(approvable ? ["approve" as const] : []), "deny", "escalate"]
                : []
            : [],
        executionState: r.execution_state,
        createdAt: new Date(r.created_at).toISOString(),
        decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
      };
    }),
  );
  return { requests, total, nextCursor: rows.length > limit ? rows[limit - 1].id : null };
}
