import { hostCapabilities } from "../../../adapters/host/capabilities.js";
import type { HostExecutor } from "../../../adapters/host/executor.js";
import { canonicalPath } from "../../../adapters/host/sandbox.js";
import type { Sql } from "../../../adapters/postgres/database.js";
import { grantsFor } from "../../access/policy.js";
import type { ReadTarget } from "./read-observations.js";

/** Current permission checks apply to metadata too, including paths and receipt references. */
export async function readObservationReader(
  sql: Sql,
  conversationId: string,
  host: Pick<HostExecutor, "assertPath">,
) {
  const conversation = (
    await sql.query(
      "select c.agent_id,c.canvas_id from conversations c join canvases v on v.id=c.canvas_id where c.id=$1 and v.deleted_at is null",
      [conversationId],
    )
  ).rows[0];
  let grants: ReturnType<typeof grantsFor> | undefined;
  let skills: ReturnType<typeof hostCapabilities> | undefined;
  return async (target: ReadTarget) => {
    if (!conversation) return false;
    try {
      if (target.kind === "skill") {
        skills ??= hostCapabilities();
        return (await skills).skills.some((skill) => skill.path === target.skillId);
      }
      if (conversation.agent_id === null) return true;
      if (!conversation.agent_id) return false;
      if (target.kind === "path") {
        if ((await canonicalPath(target.path)) !== target.path) return false;
        await host.assertPath({ agentId: conversation.agent_id }, target.path, false, sql);
        return true;
      }
      if (target.kind === "node") {
        if (target.nodeId === conversation.agent_id) return true;
        grants ??= grantsFor(sql, conversation.agent_id);
        return (await grants).some((grant) => grant.resource_id === target.nodeId);
      }
      return false;
    } catch (error) {
      // Missing/inaccessible sources hide metadata; implementation and database failures surface.
      const code = (error as { code?: string } | null)?.code;
      if (
        code &&
        ["FORBIDDEN", "NOT_FOUND", "ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(code)
      )
        return false;
      throw error;
    }
  };
}
