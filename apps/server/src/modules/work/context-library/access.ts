import type { LocalResource } from "@intrica/contracts";
import { assertFence, DomainError, digest, type Sql } from "../../../adapters/postgres/database.js";
import { type Actor, agentIdentity, grantsFor } from "../../access/policy.js";
import { coveringGrant, type ResourceGrant } from "../../access/resources.js";

export type ArchiveAccessScope = {
  version: 1;
  ownerOnly: boolean;
  hostExecution: boolean;
  resources: Array<{ id: string; resource?: LocalResource }>;
};

export function mergeArchiveScopes(scopes: ArchiveAccessScope[]): ArchiveAccessScope {
  const resources = new Map<string, ArchiveAccessScope["resources"][number]>();
  for (const scope of scopes)
    for (const resource of scope.resources) resources.set(digest(resource), resource);
  return {
    version: 1,
    ownerOnly: scopes.some((scope) => scope.ownerOnly),
    hostExecution: scopes.some((scope) => scope.hostExecution),
    resources: [...resources.values()],
  };
}

/** Every inherited source remains subject to its original scope after later compactions. */
export async function archiveScopeAllowed(
  scope: ArchiveAccessScope | null,
  grants: ResourceGrant[],
  hostExecution: boolean,
) {
  if (scope?.version !== 1 || scope.ownerOnly || (scope.hostExecution && !hostExecution))
    return false;
  for (const required of scope.resources) {
    if (
      grants.some(
        (grant) =>
          grant.resource_id === required.id &&
          digest(grant.resource ?? null) === digest(required.resource ?? null),
      )
    )
      continue;
    if (
      !required.resource ||
      !(await coveringGrant(grants, { resource: required.resource }, "read"))
    )
      return false;
  }
  return true;
}

export async function archiveReader(
  sql: Sql,
  actor: Actor,
  canvasId: string,
  conversationId: string,
) {
  if (actor.runId !== undefined && actor.epoch !== undefined)
    await assertFence(sql, actor.runId, actor.epoch);
  const conversation = (
    await sql.query(
      "select c.agent_id from conversations c join canvases v on v.id=c.canvas_id where c.id=$1 and c.canvas_id=$2 and v.deleted_at is null",
      [conversationId, canvasId],
    )
  ).rows[0];
  if (!conversation)
    throw new DomainError("NOT_FOUND", "Context library unavailable / 资料索引不存在");
  if (actor.kind === "owner") return (_scope: ArchiveAccessScope | null) => Promise.resolve(true);
  const identity = await agentIdentity(sql, actor.agentId);
  if (identity.canvas_id !== canvasId || conversation.agent_id !== actor.agentId)
    throw new DomainError(
      "FORBIDDEN",
      "Context library is private to its conversation / 资料索引仅限自身会话",
    );
  const grants = await grantsFor(sql, actor.agentId);
  const hostExecution =
    identity.config.role === "admin" || grants.some((grant) => grant.execution_mode === "host");
  return (scope: ArchiveAccessScope | null) => archiveScopeAllowed(scope, grants, hostExecution);
}
