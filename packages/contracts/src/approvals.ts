import type { ExternalMessage, MessageAddress } from "./collaboration.js";

export type AgentRole = "read" | "write" | "admin";
export type CommandPermission = "none" | "isolated" | "host";
export type ApprovalDecision = "approve" | "deny" | "escalate";
export type ApprovalStatus =
  | "pending"
  | "approved"
  | "satisfied"
  | "denied"
  | "cancelled"
  | "expired"
  | "invalidated";
export type AccessIntent =
  | { kind: "role"; role: AgentRole }
  | { kind: "resource"; nodeId: string; mode: "read" | "write"; requiredRole?: "write" }
  | {
      kind: "path";
      path: string;
      directory: boolean;
      mode?: "read" | "write";
      execution?: CommandPermission;
      requiredRole?: "write";
      /** Server-resolved ownership of an ancestor's scratch path; never a tool argument. */
      workspaceOwnerId?: string;
      workspaceRoot?: string;
    }
  | {
      kind: "host";
      tool: "read" | "rg" | "write" | "edit" | "bash" | "mcp";
      args: Record<string, any>;
      requiredRole?: "write";
      workspaceOwnerId?: string;
      workspaceRoot?: string;
    }
  | {
      kind: "agent";
      operation: "hire" | "configure" | "dismiss";
      args: Record<string, any>;
    }
  | {
      kind: "collaboration";
      recipients: string[];
      message: string;
      messageKind: string;
      targetKind?:
        | "agent"
        | "agents"
        | "canvas"
        | "resource_readers"
        | "request"
        | "manager"
        | "internal";
      dispatchId?: string;
      addresses?: MessageAddress[];
      requestId?: string | undefined;
      requestVersion?: number | undefined;
      causeId?: string | undefined;
      workItemId?: string | undefined;
      reportToManager?: boolean;
      fileVersions?: Record<string, string>;
      handoff?: ExternalMessage["handoff"];
      resourceIds?: string[];
      fileIds?: string[];
    };
export type ApprovalRecord = {
  id: string;
  agentId: string;
  toolCallId: string | null;
  status: ApprovalStatus;
  version: number;
  reviewerId: string | null;
  decidedBy: string | null;
  reason: string;
  decisionReason: string | null;
  routeReason: string;
  kind: AccessIntent["kind"];
  scope: "persistent" | "once";
  summary: {
    role?: AgentRole;
    resourceIds?: string[];
    tool?: string;
    operation?: string;
    path?: string;
    mode?: string;
    capability?: string;
    recipients?: string[];
  };
  names?: Record<string, string>;
  blockedReason?: string;
  action?: AccessIntent;
  expiresAt: string;
  reviewDueAt: string | null;
  allowedActions: ApprovalDecision[];
  executionState: string | null;
  createdAt?: string;
  decidedAt?: string | null;
};
export type ApprovalPage = { requests: ApprovalRecord[]; nextCursor: string | null; total: number };
