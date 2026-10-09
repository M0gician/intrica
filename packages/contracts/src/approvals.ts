export type AgentRole = "read" | "write" | "admin";
export type ApprovalDecision = "approve" | "deny" | "escalate";
export type ApprovalStatus =
  | "pending"
  | "approved"
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
      requiredRole?: "write";
      /** Server-resolved ownership of an ancestor's scratch path; never a tool argument. */
      workspaceOwnerId?: string;
    }
  | {
      kind: "host";
      tool: "read" | "rg" | "write" | "edit" | "bash" | "mcp";
      args: Record<string, any>;
      requiredRole?: "write";
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
