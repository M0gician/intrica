import type {
  CandidateContainerProjection,
  CandidateNodeProjection,
  ConflictDetail,
  Edge,
  Node,
  Operation,
  OperationType,
  Rect,
} from "@intrica/contracts";

export type GraphState = {
  measuredHeights: ReadonlyMap<string, number>;
  nodes: ReadonlyMap<string, Node>;
  edges: ReadonlyMap<string, Edge>;
  operations: ReadonlyMap<string, Operation>;
  candidateNodes: ReadonlyMap<string, CandidateNodeProjection>;
  candidateContainers: ReadonlyMap<string, CandidateContainerProjection>;
  graphRevision: number;
  latestModelBatchAt: string | null;
  latestModelBatchOperationId: string | null;
  /** 创建操作接口返回的队列位次（1 起）。 */
  queuePositions: ReadonlyMap<string, number>;
  /** 连接创建的本地预览；服务端确认后转入 edges，失败时移除。 */
  pendingEdges: ReadonlyMap<string, Edge>;
  pendingMoves: ReadonlyMap<string, PendingMove>;
};

export type PendingMove = {
  canvasId: string;
  targetParentId: string;
  moves: Array<{ nodeId: string; x: number; y: number; layoutVersion: number }>;
};

export type Displacement = { dx: number; dy: number };

export type OverlaySpaceState = {
  containerId: string;
  /** 候选预览空间为只读，不参与选区与结构操作。 */
  readonly: boolean;
  /** 候选预览时显示该操作的候选节点，而非已提交子节点。 */
  previewOperationId: string | null;
  bounds: Rect;
  displacement: ReadonlyMap<string, Displacement>;
};

export type DropTarget =
  | { kind: "scope"; scopeId: string }
  | { kind: "node"; nodeId: string }
  | { kind: "invalid"; reason: string };

export type DragState = {
  nodeIds: string[];
  /** 拖动起点所在作用域（baseScopeId 或覆盖空间容器 ID）。 */
  originScopeId: string;
  delta: { x: number; y: number };
  target: DropTarget | null;
  /** 是否已越过 8px 拖动阈值。 */
  active: boolean;
};

export type MarqueeState = { x1: number; y1: number; x2: number; y2: number };

export type ConflictDialogState = {
  context: "accept" | "undo";
  operationId: string | null;
  message: string;
  details: ConflictDetail[];
};

export type OperationIntent = {
  type: OperationType;
  scopeId: string;
  selection: string[];
};

/**
 * 互斥浮层：同时最多一个，打开新浮层自动关闭旧浮层（规范 §4）。
 */
export type SurfaceState =
  | { type: "create"; position: { x: number; y: number } }
  | { type: "nodeActions"; nodeId: string }
  | { type: "edgeActions"; edgeId: string; x: number; y: number }
  | { type: "more" }
  | { type: "linkConfirm"; fromId: string; toId: string }
  | { type: "confirm"; intent: OperationIntent }
  | { type: "contextPreview"; intent: OperationIntent }
  | { type: "deleteConfirm"; nodeIds: string[] }
  | { type: "opReason"; operationId: string }
  | { type: "conflict"; dialog: ConflictDialogState };

/** 详情侧栏（独立面板）：节点详情或生成审阅。打开面板时关闭浮层。 */
export type PanelState =
  | null
  | { type: "inspector"; nodeId: string | null; focusRequest?: { id: string; nonce: number } }
  | { type: "review"; operationId: string };

export type ToastAction = {
  label: string;
  kind: "undo" | "retry";
  operationId?: string;
  commandId?: string;
};

export type ToastState = {
  id: number;
  message: string;
  action: ToastAction | null;
} | null;

export type ViewState = {
  baseScopeId: string;
  overlaySpace: OverlaySpaceState | null;
  selection: ReadonlySet<string>;
  pan: { x: number; y: number };
  zoom: number;
  surface: SurfaceState | null;
  panel: PanelState;
  toast: ToastState;
  drag: DragState | null;
  marquee: MarqueeState | null;
  /** 键盘方向键微移的本地预览位移（世界坐标）。 */
  nudge: { dx: number; dy: number } | null;
  /** 删除进行中（淡出动画）的节点。 */
  deletingNodeIds: ReadonlySet<string>;
  /** 用户已关闭任务条 chip 的操作（会话内不再显示）。 */
  dismissedOperationIds: ReadonlySet<string>;
  /** aria-live="polite" 播报文本。 */
  statusMessage: string;
};

export type AppState = {
  graph: GraphState;
  view: ViewState;
};

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2.5;

export function initialGraphState(): GraphState {
  return {
    nodes: new Map(),
    measuredHeights: new Map(),
    edges: new Map(),
    operations: new Map(),
    candidateNodes: new Map(),
    candidateContainers: new Map(),
    graphRevision: 0,
    latestModelBatchAt: null,
    latestModelBatchOperationId: null,
    queuePositions: new Map(),
    pendingEdges: new Map(),
    pendingMoves: new Map(),
  };
}

export function initialViewState(): ViewState {
  const baseScopeId = "root";
  return {
    baseScopeId,
    overlaySpace: null,
    selection: new Set(),
    pan: { x: 0, y: 0 },
    zoom: 1,
    surface: null,
    panel: null,
    toast: null,
    drag: null,
    marquee: null,
    nudge: null,
    deletingNodeIds: new Set(),
    dismissedOperationIds: new Set(),
    statusMessage: "",
  };
}

export function initialAppState(): AppState {
  return { graph: initialGraphState(), view: initialViewState() };
}
