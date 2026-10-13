import type { ModelSelection } from "./model-settings.js";

export type NodeKind = "text" | "image" | "pdf" | "group" | "agent" | "todo";
export type TodoConfig = { completed: boolean };
export type NodeLifecycle = "user" | "committed";
export type NodeOrigin = "user" | "model";

export type Rect = { x: number; y: number; width: number; height: number };

export type AgentConfig = {
  saveMemoryBeforeCompaction?: boolean;
  model?: ModelSelection | null;
  portraitAssetId?: string;
  portraitVariant?: number;
  persona: string;
  role: "read" | "write" | "admin";
  /** Respond to resource changes. Cron schedules and messages are independent. */
  enabled: boolean;
  schedule?: {
    language?: "en" | "zh-CN";
    cron: string;
    prompt: string;
    enabled: boolean;
    timezone?: string;
  };
};

export type LocalResource = {
  type: "directory" | "file";
  path: string;
  snapshot?: { assetId: string; hash: string; bytes: number; mime: string; name: string };
};

export type Node = {
  canvasId: string;
  layoutVersion: number;
  sortKey: string;
  contentLoaded: boolean;
  id: string; // 永久稳定
  kind: NodeKind; // group 只表示结构容器
  parentId: string | null; // 根节点 root 为 null
  title?: string;
  resource?: LocalResource;
  agent?: AgentConfig;
  managerId?: string | null; // Read-only projection of the direct Agent parent.
  todo?: TodoConfig;
  text?: string;
  assetId?: string;
  assetVersion?: number;
  alt?: string;
  summary?: string;
  position: Rect; // 父作用域内的局部坐标
  childOrder: string[];
  lifecycle: NodeLifecycle; // 候选节点只存在于操作暂存区
  origin: NodeOrigin;
  createdAt: string; // ISO 8601；同一操作的输出相同
  revision: number;
};

export type CandidateNodeProjection = {
  id: string;
  kind: "text";
  parentId: string;
  position: Rect;
  lifecycle: "candidate";
  operationId: string;
  origin: "model";
  title?: string;
  text?: string;
};

export type CandidateContainerProjection = {
  id: string;
  kind: "group";
  parentId: string;
  position: Rect;
  lifecycle: "candidate";
  operationId: string;
  projection: "readonly_canvas" | "review_only";
  title?: string;
  summary?: string;
  childIds: string[];
};

export type EdgeType = "user_link" | "derived_from";

export type Edge = {
  id: string;
  from: string;
  to: string;
  type: EdgeType; // user_link 界面显示为“连接”
  directed: boolean; // user_link=false，derived_from=true
  confirmed: boolean;
  revision: number; // 关系记录版本，用于接受时冲突校验
  operationId?: string | null; // derived_from 必填，user_link 为空
  sourceRevision?: number | null; // 生成开始时对应输入节点的 revision
};

export type SnapshotScopeNode = {
  id: string;
  kind: NodeKind;
  title?: string;
  text?: string;
  summary?: string;
  assetId?: string;
  assetVersion?: number;
  alt?: string;
};

export type SnapshotNode = {
  id: string;
  kind: NodeKind;
  title?: string;
  text?: string;
  assetId?: string;
  assetVersion?: number;
  alt?: string;
  summary?: string;
  revision: number;
  containerPath: string[];
};

export type SnapshotEdge = {
  id: string;
  from: string;
  to: string;
  type: EdgeType;
  directed: boolean;
  confirmed: true;
  revision: number;
  operationId?: string | null;
  sourceRevision?: number | null;
};

export type ContextSnapshot = {
  snapshotVersion: 2;
  scope: SnapshotScopeNode;
  selection: string[]; // 用户选中的来源节点
  contextOnlyNodeIds: string[]; // 仅补充上下文，不建立来源边
  nodes: SnapshotNode[];
  edges: SnapshotEdge[];
  includeDescendants: string[]; // 用户明确展开其内部内容的父节点 ID
  omittedNodeIds: string[]; // 因预算省略的稳定 ID
  instruction: string; // 无补充要求时为空字符串
};

export type OperationType = "expand" | "deepen" | "compress";
export type PlacementMode =
  | "sibling"
  | "inside_selected"
  | "inside_result_container"
  | "compress_container";
export type ResultContainerState = "none" | "reserved" | "committed" | "tombstoned";
export type OperationStatus =
  | "queued"
  | "running"
  | "candidate"
  | "committed"
  | "discarded"
  | "failed"
  | "cancelled";

export type CandidateSummary = { title: string; summary: string };

export type Operation = {
  canvasId?: string;
  id: string;
  type: OperationType;
  scopeId: string; // 操作开始时的持久化父作用域
  placementMode: PlacementMode;
  selection: string[]; // 生成来源节点；不包含 contextOnlyNodeIds
  outputParentId: string | null; // 文本输出父级；压缩为 null
  resultContainerParentId: string | null; // 深化多选/压缩为 scopeId
  resultContainerId: string | null; // 深化多选或压缩摘要容器；其他情况为 null
  resultContainerState: ResultContainerState;
  outputIds: string[]; // 展开/深化的文本节点 ID；压缩可为空
  instruction: string; // 服务端从快照复制，便于索引
  undoToken?: string; // accept 后由持久化 GraphOp 生成
  status: OperationStatus;
  reason?: string | null;
  candidateSummary?: CandidateSummary;
  /** 该操作对应的 GraphOp 是否已被撤销（仅 committed 后有意义）。 */
  undone: boolean;
  createdAt: string;
};

export type WorkspaceSnapshot = {
  graphRevision: number;
  nodes: Node[];
  edges: Edge[];
  operations: Operation[];
  candidateNodes: CandidateNodeProjection[];
  candidateContainers: CandidateContainerProjection[];
};

export type AgentContextUsage = {
  tokens: number;
  contextWindow: number;
  safeLimit: number;
  source: "estimated" | "usage";
  windowSource: "configured" | "catalog" | "preset";
  modelId: string;
  state: "ready" | "compacting";
  compactions: number;
};

/** A one-shot host operation. Approval is tied to these exact arguments. */
export type LocalAgentAction = { tool: string; args: Record<string, unknown> };
