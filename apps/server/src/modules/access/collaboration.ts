import type { AccessIntent } from "@intrica/contracts";
import { DomainError, type Sql } from "../../adapters/postgres/database.js";
import { agentIdentity } from "./policy.js";
import { canvasPermissions, coveringGrant } from "./resources.js";

export type Delivery = Extract<AccessIntent, { kind: "collaboration" }>;
export type MessageTarget =
  | { kind: "agent"; agentId: string }
  | { kind: "agents"; agentIds: string[] }
  | { kind: "canvas" }
  | { kind: "resource_readers"; resourceIds: string[] };

async function requireBroadcastAuthority(sql: Sql, canvasId: string, senderId: string | null) {
  if (!senderId) return;
  const sender = await agentIdentity(sql, senderId);
  if (sender.canvas_id !== canvasId || sender.config.role !== "admin")
    throw new DomainError("FORBIDDEN", "此广播目标需要当前画布的管理员权限");
}

/** Validate the frozen audience without adding new members during recovery. */
export async function validateDelivery(
  sql: Sql,
  canvasId: string,
  senderId: string | null,
  intent: Delivery,
) {
  if (intent.targetKind === "agents" || intent.targetKind === "canvas")
    await requireBroadcastAuthority(sql, canvasId, senderId);
  const targets = await sql.query(
    "select n.id from nodes n join agent_configs a on a.node_id=n.id where n.canvas_id=$1 and n.id=any($2::text[])",
    [canvasId, intent.recipients],
  );
  if (targets.rowCount !== intent.recipients.length)
    throw new DomainError("TARGET_CHANGED", "接收者已删除或不在当前画布，消息未发送");
  if (intent.targetKind === "resource_readers") {
    const current = await resourceAudience(sql, canvasId, intent.resourceIds ?? [], senderId);
    if (intent.recipients.some((id) => !current.includes(id)))
      throw new DomainError("TARGET_CHANGED", "广播接收者权限已变化，请重新确认接收范围");
  }
}
async function resourceAudience(
  sql: Sql,
  canvasId: string,
  resourceIds: string[],
  senderId: string | null,
) {
  resourceIds = [...new Set(resourceIds)];
  if (!resourceIds.length) throw new DomainError("VALIDATION", "资源读者广播必须指定至少一个资源");
  const resources = (
    await sql.query(
      "select id,kind,body->'resource' as resource from nodes where canvas_id=$1 and id=any($2::text[])",
      [canvasId, resourceIds],
    )
  ).rows;
  if (resources.length !== resourceIds.length || resources.some((r) => r.kind === "agent"))
    throw new DomainError("NOT_FOUND", "广播资源不存在或不是资源节点");
  const permissions = await canvasPermissions(sql, canvasId);
  if (senderId)
    for (const resource of resources)
      if (!(await coveringGrant(permissions.get(senderId) ?? [], resource, "read")))
        throw new DomainError("FORBIDDEN", "广播需要全部指定资源的读取权限");
  const recipients: string[] = [];
  for (const [agentId, grants] of permissions) {
    if (agentId === senderId) continue;
    let covered = true;
    for (const resource of resources)
      if (!(await coveringGrant(grants, resource, "read"))) {
        covered = false;
        break;
      }
    if (covered) recipients.push(agentId);
  }
  return recipients.sort();
}
export async function selectRecipients(
  sql: Sql,
  canvasId: string,
  senderId: string | null,
  target: MessageTarget,
) {
  if (target.kind === "agent") return [target.agentId];
  if (target.kind === "resource_readers")
    return resourceAudience(sql, canvasId, target.resourceIds, senderId);
  await requireBroadcastAuthority(sql, canvasId, senderId);
  const ids =
    target.kind === "agents"
      ? target.agentIds
      : (
          await sql.query(
            "select n.id from nodes n join agent_configs a on a.node_id=n.id where n.canvas_id=$1 order by n.id",
            [canvasId],
          )
        ).rows.map((row) => row.id as string);
  return [...new Set(ids)].filter((id) => id !== senderId).sort();
}
