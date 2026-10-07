import { assertFence, DomainError, type Sql } from "../../adapters/postgres/database.js";
import { canvasPermissions, coveringGrant } from "./resources.js";
export type Actor =
  | { kind: "owner"; runId?: string; epoch?: number }
  | {
      kind: "agent";
      agentId: string;
      runId: string;
      epoch: number;
    };
export const OWNER: Actor = { kind: "owner" };
export const actorId = (actor: Actor) => (actor.kind === "owner" ? "owner" : actor.agentId);
export async function agentIdentity(sql: Sql, agentId: string) {
  const { rows } = await sql.query(
    "select a.*,n.canvas_id,n.parent_id,parent_agent.node_id as manager_id from agent_configs a join nodes n on n.id=a.node_id left join agent_configs parent_agent on parent_agent.node_id=n.parent_id join canvases c on c.id=n.canvas_id where a.node_id=$1 and c.deleted_at is null",
    [agentId],
  );
  if (!rows[0]) throw new DomainError("NOT_FOUND", "Agent 不存在");
  return rows[0];
}
export async function grantsFor(sql: Sql, agentId: string) {
  const { canvas_id } = await agentIdentity(sql, agentId);
  return (await canvasPermissions(sql, canvas_id)).get(agentId) ?? [];
}
export async function managementChain(sql: Sql, subject: string): Promise<string[]> {
  return (
    await sql.query(
      `with recursive chain as (
    select p.id,p.parent_id,1 as depth,array[n.id,p.id] as seen from nodes n join nodes p on p.id=n.parent_id and p.kind='agent' where n.id=$1
    union all select p.id,p.parent_id,c.depth+1,c.seen||p.id from chain c join nodes p on p.id=c.parent_id and p.kind='agent' where not(p.id=any(c.seen))
  ) select id from chain order by depth`,
      [subject],
    )
  ).rows.map((n) => n.id);
}
export async function canReadAgentResources(sql: Sql, reader: string, subject: string) {
  const available = await grantsFor(sql, reader);
  for (const g of (await grantsFor(sql, subject)).filter((g) => g.resource_kind !== "agent"))
    if (!(await coveringGrant(available, { id: g.resource_id, resource: g.resource }, "read")))
      return false;
  return true;
}
/** Team communication is authorized by a common manager, not by equal tool scopes.
 * A private grant outside that manager's readable scope remains a boundary. */
export async function commonTeamManager(sql: Sql, left: string, right: string) {
  const leftChain = [left, ...(await managementChain(sql, left))];
  const rightChain = new Set([right, ...(await managementChain(sql, right))]);
  for (const id of leftChain) {
    if (!rightChain.has(id)) continue;
    if (
      (await agentIdentity(sql, id)).config.role === "admin" &&
      (await canReadAgentResources(sql, id, left)) &&
      (await canReadAgentResources(sql, id, right))
    )
      return id;
  }
  return null;
}
/** Team authority permits coordination without copying tool grants. Outside an
 * authorized team, scope bridging and higher-role activation require approval. */
export async function collaborationNeedsApproval(
  sql: Sql,
  senderId: string,
  targetId: string,
  report = false,
) {
  const sender = await agentIdentity(sql, senderId);
  const target = await agentIdentity(sql, targetId);
  if (sender.canvas_id !== target.canvas_id) return true;
  if (await commonTeamManager(sql, senderId, targetId)) return false;
  const left = (await grantsFor(sql, senderId)).filter((g) => g.resource_kind !== "agent");
  const right = (await grantsFor(sql, targetId)).filter((g) => g.resource_kind !== "agent");
  const covers = async (available: typeof left, required: typeof left, readOnly = false) => {
    for (const needed of required)
      if (
        !(await coveringGrant(
          available,
          { id: needed.resource_id, resource: needed.resource },
          readOnly ? "read" : needed.mode,
        ))
      )
        return false;
    return true;
  };
  const ranks: Record<string, number> = { read: 0, write: 1, admin: 2 };
  return (
    (!(report && sender.manager_id === targetId) && !(await covers(left, right))) ||
    !(await covers(right, left, report)) ||
    (!report && ranks[target.config.role]! > ranks[sender.config.role]!)
  );
}
/** Only uninterrupted Agent parentage forms a management team. */
export async function teamMemberIds(sql: Sql, managerId: string): Promise<string[]> {
  return (
    await sql.query(
      `with recursive team as (
        select id from nodes where parent_id=$1 and kind='agent'
        union all select n.id from nodes n join team t on n.parent_id=t.id where n.kind='agent'
      ) select id from team`,
      [managerId],
    )
  ).rows.map((row) => row.id);
}
export async function authorize(
  sql: Sql,
  actor: Actor,
  canvasId: string,
  resourceId: string | null,
  mode: "read" | "write" | "manage",
) {
  if (actor.kind === "owner") {
    if (actor.runId !== undefined && actor.epoch !== undefined)
      await assertFence(sql, actor.runId, actor.epoch);
    return;
  }
  await assertFence(sql, actor.runId, actor.epoch);
  const identity = await agentIdentity(sql, actor.agentId);
  if (identity.canvas_id !== canvasId) throw new DomainError("FORBIDDEN", "Agent 不在此画布中");
  if (mode === "manage") {
    throw new DomainError("FORBIDDEN", "管理权限需要用户操作");
  }
  if (mode === "write" && identity.config.role === "read")
    throw new DomainError("FORBIDDEN", "只读 Agent 需要写入授权");
  if (resourceId === null) return; // Creating a new artifact in this canvas; never changes another resource.
  const target = (
    await sql.query("select kind from nodes where id=$1 and canvas_id=$2", [resourceId, canvasId])
  ).rows[0];
  if (!target) throw new DomainError("NOT_FOUND", "资源不存在");
  if (mode === "write" && target.kind === "agent")
    throw new DomainError("FORBIDDEN", "Agent 配置由用户管理");
  if (mode === "read" && resourceId === actor.agentId) return;
  const grants = await grantsFor(sql, actor.agentId);
  if (!grants.some((g) => g.resource_id === resourceId && (mode === "read" || g.mode === "write")))
    throw new DomainError("FORBIDDEN", "需要此资源的明确授权");
}
