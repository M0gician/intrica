import { join } from "node:path";
import { canonicalPath, withinPath } from "../../adapters/host/sandbox.js";
import type { Sql } from "../../adapters/postgres/database.js";
import { agentIdentity, managementChain } from "./policy.js";

/** Physical ownership only. An administrator or a spatial parent is not a file owner. */
export async function workspaceOwnership(sql: Sql, dataDir: string, subject: string, path: string) {
  const identity = await agentIdentity(sql, subject);
  const root = join(await canonicalPath(dataDir), "workspaces", identity.canvas_id);
  if ((await canonicalPath(root)) !== root) return {};
  for (const owner of [subject, ...(await managementChain(sql, subject))]) {
    const expected = join(root, owner);
    if ((await canonicalPath(expected)) === expected && withinPath(expected, path))
      return { workspaceOwnerId: owner, workspaceRoot: expected };
  }
  return {};
}
export async function validWorkspaceOwner(
  sql: Sql,
  subject: string,
  intent: { workspaceOwnerId?: string; workspaceRoot?: string },
  path: string,
) {
  if (!intent.workspaceOwnerId || !intent.workspaceRoot) return false;
  const owner = await agentIdentity(sql, intent.workspaceOwnerId);
  const applicant = await agentIdentity(sql, subject);
  return (
    owner.canvas_id === applicant.canvas_id &&
    (owner.node_id === subject || (await managementChain(sql, subject)).includes(owner.node_id)) &&
    (await canonicalPath(intent.workspaceRoot)) === intent.workspaceRoot &&
    withinPath(intent.workspaceRoot, path)
  );
}
