import type { GraphMutationResponse } from "./graph-commit.js";
import type {
  AgentConfig,
  ContextSnapshot,
  Edge,
  LocalResource,
  Node,
  Operation,
  OperationType,
  Rect,
  WorkspaceSnapshot,
} from "./model.js";

export type ServerInfo = {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  graphProtocol: number;
  web: { enabled: boolean };
};

export type UnknownToolReview = {
  id: string;
  name: string;
  args: unknown;
  canRetry: boolean;
  result?: unknown;
  runId?: string;
  createdAt?: string;
  updatedAt?: string;
  lastConfirmedAt?: string | null;
  targetPath?: string | null;
  workingDirectory?: string | null;
};

export type EffectiveAgentPermissions = {
  role: "read" | "write" | "admin";
  resources: Array<{
    nodeId: string;
    rootId: string;
    title: string;
    mode: "read" | "write";
    sourceLinkId: string;
    delegatedBy: string | null;
  }>;
  totalResources: number;
};

export type ServerCapabilities = {
  server: { files: boolean; terminals: boolean; assets: boolean; models: boolean };
  agent: { enabled: boolean; canvas: boolean; browserAutomation: boolean };
  desktop: { nativeBrowser: boolean; nativeNotifications: boolean; filePicker: boolean };
};

/** 所有需要幂等键的写请求共用的请求体。 */
export type IdempotencyBody = { idempotencyKey: string };

export type CreateNodeRequest = {
  kind: "text" | "image" | "pdf" | "agent" | "todo";
  parentId: string;
  title?: string;
  resource?: LocalResource;
  agent?: AgentConfig;
  todo?: import("./model.js").TodoConfig;
  text?: string;
  assetId?: string;
  assetVersion?: number;
  alt?: string;
  position: Rect;
  index?: number; // 插入 childOrder 的位置；缺省追加
  idempotencyKey: string;
};

export type UpdateNodeRequest = {
  todo?: import("./model.js").TodoConfig;
  agent?: AgentConfig;
  summary?: string;
  expectedRevision: number;
  title?: string;
  text?: string;
  alt?: string;
  idempotencyKey: string;
};

/** 多选整体移动：所有节点当前必须同父，且使用同一目标父级。 */
export type MoveEntry = {
  nodeId: string;
  x: number;
  y: number;
  index?: number;
  expectedLayoutVersion?: number | undefined;
};

export type MoveGraphOpRequest = {
  kind: "move";
  targetParentId: string;
  moves: MoveEntry[];
  idempotencyKey: string;
};

/** 可撤销删除：删除节点及其子树，同时删除触及的全部关系；一次撤销完全恢复。 */
export type DeleteNodesGraphOpRequest = {
  kind: "delete";
  nodeIds: string[];
  idempotencyKey: string;
};

export type SubmitGraphOpRequest = MoveGraphOpRequest | DeleteNodesGraphOpRequest;

export type CreateLinkRequest = {
  fromId: string;
  toId: string;
  idempotencyKey: string;
};

export type DeleteLinkRequest = {
  expectedRevision: number;
  idempotencyKey: string;
};

/** 上下文预览与创建操作共用同一组意图字段；服务端从 GraphStore 重建权威快照。 */
export type OperationIntentRequest = {
  type: OperationType;
  scopeId: string;
  selection: string[];
  includeDescendants: string[]; // 勾选“包含内部 N 项”的父节点
  includeConnected: boolean; // 勾选“包含已连接节点/关系（N）”
  instruction: string;
};

export type PreviewOperationRequest = OperationIntentRequest;
export type CreateOperationRequest = OperationIntentRequest & IdempotencyBody;

export type ContextPreview = {
  blockedPdfNodeIds?: string[]; // PDF context requires Agent node-target read; never enqueue generation.
  draft: ContextSnapshot; // 服务端按当前勾选构建的快照草稿
  neighborIds: string[]; // 可勾选的一跳邻接（选区外）
  descendantCounts: Record<string, number>; // 选区内有子节点的节点 → 内部直接子项数
  estimatedChars: number;
  budgetChars: number;
  visionRequired: boolean; // 快照中含图片
  visionSupported: boolean; // 当前模型是否支持视觉输入
};

export type NodeResponse = { node: Node; graphRevision: number };
export type NodeMutationResponse = NodeResponse & GraphMutationResponse;
export type EdgeResponse = GraphMutationResponse & { edge: Edge };
export type GraphOpResponse = GraphMutationResponse;
export type AcceptOperationResponse = OperationDecisionResponse & GraphMutationResponse;
export type UndoResponse = { graphRevision: number; undoneGraphOpId: string };
export type OperationResponse = { operation: Operation; queuePosition: number | null };

/** accept/discard/cancel 与操作撤销的统一响应：accept 带 op.commit，discard/cancel 带 op.terminal，撤销为 null。 */
export type OperationDecisionResponse = {
  operation: Operation;
  graphRevision: number;
};
export type PreviewResponse = { preview: ContextPreview };
export type RetryOperationResponse = { discardedOperationId: string; operation: Operation };
export type AssetResponse = {
  pageCount?: number;
  assetId: string;
  assetVersion: number;
  width: number;
  height: number;
  mime: string;
};

export type SnapshotResponse = WorkspaceSnapshot & {
  activeCanvasId: string | null;
  canvasSeq: string;
  latestModelBatchAt: string | null;
  latestModelBatchOperationId: string | null;
};

export type ConflictDetail = {
  kind: "node" | "edge" | "parent" | "asset" | "dependency";
  id: string;
  reason: string;
};

export const ERROR_CODES = [
  "VALIDATION",
  "NOT_FOUND",
  "VERSION_CONFLICT",
  "SCOPE_MISMATCH",
  "ANCESTOR_IN_SELECTION",
  "INVALID_DROP_TARGET",
  "DUPLICATE_LINK",
  "SELF_LINK",
  "CROSS_SCOPE_LINK",
  "VISION_UNSUPPORTED",
  "INVALID_STATE",
  "ACCEPT_CONFLICT",
  "UNDO_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "ASSET_INVALID",
  "PAYLOAD_TOO_LARGE",
  "CONTEXT_BUDGET",
  "INTERNAL",
  "RESET_REQUIRED",
  "STALE_EXECUTION",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "QUEUE_FULL",
  "LIMIT_REACHED",
  "MODEL_ERROR",
  "DISCOVERY_FAILED",
  "HOST_UNAVAILABLE",
  "CANCELLED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type ApiErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
    details?: ConflictDetail[];
    upstreamStatus?: number;
  };
};
