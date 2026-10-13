import type { AgentRole, CommandPermission } from "@intrica/contracts";
import { type Database, DomainError } from "../../adapters/postgres/database.js";
import { agentIdentity, grantsFor, teamMemberIds } from "./policy.js";

/** One current snapshot supplies both model instructions and tool discovery. */
export type AgentCapabilities = {
  role: AgentRole | "owner";
  agentId: string | null;
  canvasId: string;
  managerId: string | null;
  persona: string;
  saveMemory: boolean;
  manageTeam: boolean;
  broadcastCanvas: boolean;
  writeNodes: boolean;
  hostExecution: boolean;
  managedAgentIds: string[];
  resources: {
    nodeId: string;
    rootId: string;
    mode: "read" | "write";
    execution: CommandPermission;
  }[];
  totalResources: number;
};

export async function agentCapabilities(
  db: Database,
  canvasId: string,
  agentId: string | null,
): Promise<AgentCapabilities> {
  return db.canvas(canvasId, async (tx) => {
    if (!agentId)
      return {
        role: "owner",
        agentId,
        canvasId,
        managerId: null,
        persona: "",
        saveMemory: true,
        manageTeam: true,
        broadcastCanvas: true,
        writeNodes: true,
        hostExecution: true,
        managedAgentIds: [],
        resources: [],
        totalResources: 0,
      };
    const identity = await agentIdentity(tx, agentId);
    if (identity.canvas_id !== canvasId) throw new DomainError("FORBIDDEN", "Agent 不在当前画布");
    const grants = await grantsFor(tx, agentId);
    const role = identity.config.role as AgentRole;
    return {
      role,
      agentId,
      canvasId,
      managerId: identity.manager_id ?? null,
      persona: identity.config.persona ?? "",
      saveMemory: identity.config.saveMemoryBeforeCompaction !== false,
      manageTeam: role === "admin",
      broadcastCanvas: role === "admin",
      writeNodes: role !== "read",
      hostExecution: role === "admin" || grants.some((g) => g.execution_mode === "host"),
      managedAgentIds: role === "admin" ? await teamMemberIds(tx, agentId) : [],
      resources: grants.slice(0, 40).map((g) => ({
        nodeId: g.resource_id,
        rootId: g.root_resource_id,
        mode: g.mode,
        execution: g.execution_mode,
      })),
      totalResources: grants.length,
    };
  });
}
