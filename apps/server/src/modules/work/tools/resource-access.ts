import type { Tx } from "../../../adapters/postgres/database.js";
import { DomainError } from "../../../adapters/postgres/database.js";
import { agentIdentity, authorize, grantsFor } from "../../access/policy.js";
import { result } from "../../execution/tool-calls.js";
import type { ToolContext } from "./context.js";

export async function resourcePermission(
  { registry, actor, ctx }: ToolContext,
  tx: Tx,
  callId: string,
  nodeId: string,
  mode: "read" | "write",
  reason: string,
  complete = false,
) {
  try {
    await authorize(tx, actor, ctx.run.canvas_id, nodeId, mode);
    return complete ? result({ status: "granted" }) : undefined;
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== "FORBIDDEN" || actor.kind !== "agent")
      throw error;
  }
  const identity = await agentIdentity(tx, actor.agentId);
  const target = await registry.graph.queries.node(nodeId, tx);
  if (target.kind === "agent" && mode === "write")
    throw new DomainError("FORBIDDEN", "使用 configure_agent 修改 Agent");
  const raw = (await grantsFor(tx, actor.agentId)).find((g) => g.resource_id === nodeId);
  const needsWriteRole = mode === "write" && identity.config.role === "read";
  return registry.access.gate(
    tx,
    actor,
    callId,
    needsWriteRole && raw?.granted_mode === "write"
      ? { kind: "role", role: "write" }
      : {
          kind: "resource",
          nodeId,
          mode,
          ...(needsWriteRole ? { requiredRole: "write" as const } : {}),
        },
    reason,
    complete,
  );
}
