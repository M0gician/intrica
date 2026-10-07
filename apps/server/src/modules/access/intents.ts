import { stat } from "node:fs/promises";
import type { AccessIntent, AgentRole, ApprovalRecord } from "@intrica/contracts";
import { canonicalPath, withinPath } from "../../adapters/host/sandbox.js";
import { DomainError, type Sql } from "../../adapters/postgres/database.js";
import { agentIdentity, canReadAgentResources, grantsFor, managementChain } from "./policy.js";
import { coveringGrant } from "./resources.js";

export const roleRank = { read: 0, write: 1, admin: 2 };
export async function roleDelta(sql: Sql, subject: string, role: AgentRole) {
  const a = await agentIdentity(sql, subject);
  const grants = await grantsFor(sql, subject);
  return a.config.role === "read" && role !== "read"
    ? grants
        .filter((g) => g.granted_mode === "write" && g.resource_kind !== "agent")
        .map((g) => g.resource_id as string)
        .sort()
    : [];
}
export async function canGrantRole(sql: Sql, managerId: string, subject: string, role: AgentRole) {
  const m = await agentIdentity(sql, managerId);
  if (
    role === "admin" ||
    !(await managementChain(sql, subject)).includes(managerId) ||
    m.config.role !== "admin"
  )
    return false;
  const available = await grantsFor(sql, managerId);
  const required = await grantsFor(sql, subject);
  for (const id of await roleDelta(sql, subject, role)) {
    const need = required.find((g) => g.resource_id === id)!;
    let covered = false;
    for (const grant of available.filter((g) => g.mode === "write")) {
      if (grant.resource_id === id) {
        covered = true;
        break;
      }
      if (
        need.resource &&
        grant.resource &&
        grant.resource.type === "directory" &&
        withinPath(
          await canonicalPath(grant.resource.path),
          await canonicalPath(need.resource.path),
        )
      ) {
        covered = true;
        break;
      }
    }
    if (!covered) return false;
  }
  return true;
}
export function operation(intent: AccessIntent) {
  const { requiredRole: _, ...action } = intent as AccessIntent & { requiredRole?: AgentRole };
  return action;
}
export async function reviewerFor(
  sql: Sql,
  subject: string,
  _intent: AccessIntent,
  after?: string,
) {
  const chain = await managementChain(sql, subject);
  return chain[after ? chain.indexOf(after) + 1 : 0] ?? null;
}
/** Routing is hierarchy, approval is authority. A manager may always decline or
 * escalate its inbox; being the reviewer never creates new authority. */
export async function canApprove(
  sql: Sql,
  reviewer: string,
  subject: string,
  intent: AccessIntent,
) {
  const manager = await agentIdentity(sql, reviewer);
  if (manager.config.role !== "admin" || !(await managementChain(sql, subject)).includes(reviewer))
    return false;
  const role =
    intent.kind === "role"
      ? intent.role
      : "requiredRole" in intent
        ? intent.requiredRole
        : undefined;
  if (role && !(await canGrantRole(sql, reviewer, subject, role))) return false;
  const grants = await grantsFor(sql, reviewer);
  if (intent.kind === "role") return true;
  if (intent.kind === "resource") {
    const target = (
      await sql.query(
        "select id,body->'resource' as resource from nodes where id=$1 and canvas_id=$2",
        [intent.nodeId, manager.canvas_id],
      )
    ).rows[0];
    return Boolean(target && (await coveringGrant(grants, target, intent.mode)));
  }
  if (intent.kind === "path" || intent.kind === "host") {
    if (intent.kind === "path" && intent.workspaceOwnerId === reviewer) return true;
    // Admin already has full-host command authority. cwd is not a process boundary.
    if (intent.kind === "host" && ["bash", "mcp"].includes(intent.tool))
      return canReadAgentResources(sql, reviewer, subject);
    const path = intent.kind === "path" ? intent.path : (intent.args.path ?? intent.args.cwd);
    if (!path) return false;
    const mode =
      intent.kind === "path" || (intent.kind === "host" && ["read", "rg"].includes(intent.tool))
        ? "read"
        : "write";
    return (
      Boolean(await coveringGrant(grants, { resource: { path, type: "file" } }, mode)) &&
      (intent.kind === "path" || (await canReadAgentResources(sql, reviewer, subject)))
    );
  }
  if (intent.kind === "agent") {
    if (intent.operation === "hire") {
      if (intent.args.role === "admin") return false;
      for (const id of intent.args.resourceIds ?? []) {
        const target = (
          await sql.query(
            "select id,body->'resource' as resource from nodes where id=$1 and canvas_id=$2",
            [id, manager.canvas_id],
          )
        ).rows[0];
        if (
          !target ||
          !(await coveringGrant(grants, target, intent.args.resourceModes?.[id] ?? "read"))
        )
          return false;
      }
      return canReadAgentResources(sql, reviewer, subject);
    }
    return mayManage(sql, reviewer, intent);
  }
  for (const member of [subject, ...intent.recipients]) {
    const identity = await agentIdentity(sql, member);
    if (identity.canvas_id !== manager.canvas_id) return false;
    for (const g of (await grantsFor(sql, member)).filter((g) => g.resource_kind !== "agent"))
      if (
        !(await coveringGrant(
          grants,
          { id: g.resource_id, resource: g.resource },
          intent.messageKind === "report" ? "read" : g.mode,
        ))
      )
        return false;
  }
  return true;
}
export async function intentBasis(sql: Sql, subject: string, intent: AccessIntent) {
  const identity = await agentIdentity(sql, subject);
  const base: Record<string, unknown> = { role: identity.config.role };
  if (intent.kind === "role" || "requiredRole" in intent)
    base.delta = await roleDelta(
      sql,
      subject,
      intent.kind === "role" ? intent.role : intent.requiredRole!,
    );
  if (intent.kind === "resource") {
    const n = (
      await sql.query(
        "select id,canvas_id,kind,body->'resource' as resource from nodes where id=$1",
        [intent.nodeId],
      )
    ).rows[0];
    if (!n || n.canvas_id !== identity.canvas_id)
      throw new DomainError("NOT_FOUND", "资源已删除或不在当前画布");
    base.target = n;
    base.grant =
      (await grantsFor(sql, subject)).find((g) => g.resource_id === intent.nodeId)?.granted_mode ??
      null;
  }
  if (intent.kind === "host" || intent.kind === "path") {
    const path = intent.kind === "path" ? intent.path : (intent.args.path ?? intent.args.cwd);
    const resolved = await canonicalPath(path);
    if (resolved !== path)
      throw new DomainError("TARGET_CHANGED", "路径目标已变化，请重新发起操作");
    if (intent.kind === "path") {
      if ((await stat(path)).isDirectory() !== intent.directory)
        throw new DomainError("TARGET_CHANGED", "路径类型已变化");
    }
    base.path = resolved;
    if (intent.kind === "path" && intent.workspaceOwnerId) {
      const owner = await agentIdentity(sql, intent.workspaceOwnerId);
      if (
        owner.canvas_id !== identity.canvas_id ||
        (owner.node_id !== subject &&
          !(await managementChain(sql, subject)).includes(owner.node_id))
      )
        throw new DomainError("TARGET_CHANGED", "工作区所属团队已变化，请重新申请");
      base.workspaceOwnerId = owner.node_id;
    }
  }
  if (intent.kind === "agent") {
    if (intent.operation === "hire") {
      base.parent = subject;
      const available = await grantsFor(sql, subject);
      base.resources = (intent.args.resourceIds ?? []).map((id: string) => {
        const grant = available.find((g) => g.resource_id === id);
        return [id, grant?.mode ?? null, grant?.id ?? null];
      });
    } else {
      const target = intent.args.agentId ?? subject;
      const rows =
        intent.operation === "dismiss"
          ? (
              await sql.query(
                `with recursive tree as (select id from nodes where id=$1 and canvas_id=$2 union all select n.id from nodes n join tree t on n.parent_id=t.id) select n.id,n.parent_id,n.content_version,n.layout_version from nodes n join tree t on n.id=t.id order by n.id`,
                [target, identity.canvas_id],
              )
            ).rows
          : (
              await sql.query(
                "select n.id,n.parent_id,n.content_version,a.config from nodes n join agent_configs a on a.node_id=n.id where n.id=$1 and n.canvas_id=$2",
                [target, identity.canvas_id],
              )
            ).rows;
      if (!rows.length) throw new DomainError("NOT_FOUND", "Agent 已删除");
      base.targets = rows;
    }
  }
  if (intent.kind === "collaboration") {
    if (intent.messageKind === "report") base.managerId = identity.manager_id;
    base.participants = await Promise.all(
      [subject, ...intent.recipients].sort().map(async (id) => {
        const a = await agentIdentity(sql, id);
        if (a.canvas_id !== identity.canvas_id)
          throw new DomainError("FORBIDDEN", "不能跨画布发送");
        return {
          id,
          role: a.config.role,
          grants: (await grantsFor(sql, id)).map((g) => [g.resource_id, g.mode]).sort(),
        };
      }),
    );
  }
  return base;
}
export async function mayManage(
  sql: Sql,
  subject: string,
  intent: Extract<AccessIntent, { kind: "agent" }>,
) {
  const a = await agentIdentity(sql, subject);
  if (intent.operation === "hire") return a.config.role === "admin" && intent.args.role !== "admin";
  const target = await agentIdentity(sql, intent.args.agentId);
  if (target.canvas_id !== a.canvas_id)
    throw new DomainError("FORBIDDEN", "不能修改其他画布的 Agent");
  if (
    intent.operation === "configure" &&
    intent.args.expectedRevision !==
      (await sql.query("select content_version from nodes where id=$1", [target.node_id])).rows[0]
        .content_version
  )
    throw new DomainError("VERSION_CONFLICT", "Agent 配置已变化，请重新读取");
  if (
    intent.operation === "configure" &&
    target.node_id === subject &&
    Object.keys(intent.args.patch).every((key) => key === "schedule")
  )
    return true;
  if (!(await managementChain(sql, target.node_id)).includes(subject) || a.config.role !== "admin")
    return false;
  if (intent.operation === "configure") {
    if (intent.args.patch.role === "admin" && target.config.role !== "admin") return false;
    if (
      intent.args.patch.role &&
      intent.args.patch.role !== target.config.role &&
      !(await canGrantRole(sql, subject, target.node_id, intent.args.patch.role))
    )
      return false;
  }
  if (!(await canReadAgentResources(sql, subject, target.node_id))) return false;
  if (intent.operation === "dismiss") {
    const scope = await grantsFor(sql, subject);
    const tree = (
      await sql.query(
        "with recursive tree as(select id,kind from nodes where id=$1 union all select n.id,n.kind from nodes n join tree t on n.parent_id=t.id) select * from tree",
        [target.node_id],
      )
    ).rows;
    for (const n of tree) {
      if (n.kind === "agent") {
        if (!(await canReadAgentResources(sql, subject, n.id))) return false;
      } else if (!scope.some((g) => g.resource_id === n.id && g.mode === "write")) return false;
    }
  }
  return true;
}
export function intentSummary(
  intent: AccessIntent,
  basis: Record<string, any>,
): ApprovalRecord["summary"] {
  switch (intent.kind) {
    case "role":
      return { role: intent.role, resourceIds: basis.delta ?? [] };
    case "resource":
      return {
        mode: intent.mode,
        resourceIds: [intent.nodeId],
        ...(intent.requiredRole ? { role: intent.requiredRole } : {}),
      };
    case "path":
      return { path: intent.path, ...(intent.requiredRole ? { role: intent.requiredRole } : {}) };
    case "host":
      return {
        tool: intent.tool,
        path: intent.args.path ?? intent.args.cwd,
        ...(intent.requiredRole ? { role: intent.requiredRole } : {}),
      };
    case "agent":
      return {
        operation: intent.operation,
        role: intent.operation === "configure" ? intent.args.patch.role : intent.args.role,
      };
    case "collaboration":
      return { operation: intent.messageKind, recipients: intent.recipients };
    default:
      return {};
  }
}
