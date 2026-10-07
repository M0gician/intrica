import { Type } from "typebox";
import { PORTRAIT_VARIANTS } from "./portraits.js";

export const RectSchema = Type.Object({
  x: Type.Number(),
  y: Type.Number(),
  width: Type.Number(),
  height: Type.Number(),
});

export const NodeKindSchema = Type.Union([
  Type.Literal("text"),
  Type.Literal("image"),
  Type.Literal("pdf"),
  Type.Literal("group"),
  Type.Literal("agent"),
  Type.Literal("todo"),
]);

export const EdgeTypeSchema = Type.Union([Type.Literal("user_link"), Type.Literal("derived_from")]);

export const LocalResourceSchema = Type.Object(
  {
    type: Type.Union([Type.Literal("directory"), Type.Literal("file")]),
    path: Type.String({ minLength: 1, maxLength: 4096 }),
  },
  { additionalProperties: false },
);

export const ModelSelectionSchema = Type.Object(
  {
    profileId: Type.String({ minLength: 1, maxLength: 100 }),
    thinkingLevel: Type.Optional(
      Type.Union(
        (["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map((value) =>
          Type.Literal(value),
        ),
      ),
    ),
  },
  { additionalProperties: false },
);

export const AgentConfigSchema = Type.Object(
  {
    saveMemoryBeforeCompaction: Type.Optional(Type.Boolean()),
    model: Type.Optional(Type.Union([ModelSelectionSchema, Type.Null()])),
    portraitAssetId: Type.Optional(Type.String({ maxLength: 100 })),
    portraitVariant: Type.Optional(Type.Integer({ minimum: 0, maximum: PORTRAIT_VARIANTS - 1 })),
    persona: Type.String({ maxLength: 8000 }),
    role: Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("admin")]),
    enabled: Type.Boolean(),
    schedule: Type.Optional(
      Type.Object({
        language: Type.Optional(Type.Union([Type.Literal("en"), Type.Literal("zh-CN")])),
        cron: Type.String({ minLength: 1, maxLength: 100 }),
        timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        prompt: Type.String({ minLength: 1, maxLength: 8000 }),
        enabled: Type.Boolean(),
      }),
    ),
  },
  { additionalProperties: false },
);

export const NodeSchema = Type.Object({
  canvasId: Type.String(),
  layoutVersion: Type.Integer({ minimum: 0 }),
  sortKey: Type.String({ pattern: "^-?\\d+$" }),
  contentLoaded: Type.Boolean(),
  managerId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  id: Type.String(),
  kind: NodeKindSchema,
  parentId: Type.Union([Type.String(), Type.Null()]),
  title: Type.Optional(Type.String()),
  resource: Type.Optional(LocalResourceSchema),
  agent: Type.Optional(AgentConfigSchema),
  todo: Type.Optional(Type.Object({ completed: Type.Boolean() })),
  text: Type.Optional(Type.String()),
  assetId: Type.Optional(Type.String()),
  assetVersion: Type.Optional(Type.Number()),
  alt: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  position: RectSchema,
  childOrder: Type.Array(Type.String()),
  lifecycle: Type.Union([Type.Literal("user"), Type.Literal("committed")]),
  origin: Type.Union([Type.Literal("user"), Type.Literal("model")]),
  createdAt: Type.String(),
  revision: Type.Number(),
});

export const CandidateNodeProjectionSchema = Type.Object({
  id: Type.String(),
  kind: Type.Literal("text"),
  parentId: Type.String(),
  position: RectSchema,
  lifecycle: Type.Literal("candidate"),
  operationId: Type.String(),
  origin: Type.Literal("model"),
  title: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
});

export const CandidateContainerProjectionSchema = Type.Object({
  id: Type.String(),
  kind: Type.Literal("group"),
  parentId: Type.String(),
  position: RectSchema,
  lifecycle: Type.Literal("candidate"),
  operationId: Type.String(),
  projection: Type.Union([Type.Literal("readonly_canvas"), Type.Literal("review_only")]),
  title: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  childIds: Type.Array(Type.String()),
});

export const EdgeSchema = Type.Object({
  id: Type.String(),
  from: Type.String(),
  to: Type.String(),
  type: EdgeTypeSchema,
  directed: Type.Boolean(),
  confirmed: Type.Boolean(),
  revision: Type.Number(),
  operationId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  sourceRevision: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});

export const SnapshotScopeNodeSchema = Type.Object({
  id: Type.String(),
  kind: NodeKindSchema,
  title: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  assetId: Type.Optional(Type.String()),
  assetVersion: Type.Optional(Type.Number()),
  alt: Type.Optional(Type.String()),
});

export const SnapshotNodeSchema = Type.Object({
  id: Type.String(),
  kind: NodeKindSchema,
  title: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  assetId: Type.Optional(Type.String()),
  assetVersion: Type.Optional(Type.Number()),
  alt: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  revision: Type.Number(),
  containerPath: Type.Array(Type.String()),
});

export const SnapshotEdgeSchema = Type.Object({
  id: Type.String(),
  from: Type.String(),
  to: Type.String(),
  type: EdgeTypeSchema,
  directed: Type.Boolean(),
  confirmed: Type.Literal(true),
  revision: Type.Number(),
  operationId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  sourceRevision: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});

export const ContextSnapshotSchema = Type.Object({
  snapshotVersion: Type.Literal(2),
  scope: SnapshotScopeNodeSchema,
  selection: Type.Array(Type.String()),
  contextOnlyNodeIds: Type.Array(Type.String()),
  nodes: Type.Array(SnapshotNodeSchema),
  edges: Type.Array(SnapshotEdgeSchema),
  includeDescendants: Type.Array(Type.String()),
  omittedNodeIds: Type.Array(Type.String()),
  instruction: Type.String(),
});

export const OperationTypeSchema = Type.Union([
  Type.Literal("expand"),
  Type.Literal("deepen"),
  Type.Literal("compress"),
]);

export const PlacementModeSchema = Type.Union([
  Type.Literal("sibling"),
  Type.Literal("inside_selected"),
  Type.Literal("inside_result_container"),
  Type.Literal("compress_container"),
]);

export const ResultContainerStateSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("reserved"),
  Type.Literal("committed"),
  Type.Literal("tombstoned"),
]);

export const OperationStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("candidate"),
  Type.Literal("committed"),
  Type.Literal("discarded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

/* ---------- API 请求体 ---------- */

export const IdempotencyBodySchema = Type.Object({
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
});

export const CreateNodeBodySchema = Type.Object({
  kind: Type.Union([
    Type.Literal("text"),
    Type.Literal("image"),
    Type.Literal("pdf"),
    Type.Literal("agent"),
    Type.Literal("todo"),
  ]),
  parentId: Type.String({ minLength: 1 }),
  title: Type.Optional(Type.String({ maxLength: 500 })),
  resource: Type.Optional(LocalResourceSchema),
  agent: Type.Optional(AgentConfigSchema),
  todo: Type.Optional(Type.Object({ completed: Type.Boolean() })),
  text: Type.Optional(Type.String({ maxLength: 50_000 })),
  assetId: Type.Optional(Type.String()),
  assetVersion: Type.Optional(Type.Number()),
  alt: Type.Optional(Type.String({ maxLength: 1000 })),
  position: RectSchema,
  index: Type.Optional(Type.Number()),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
});

export const UpdateNodeBodySchema = Type.Object({
  todo: Type.Optional(Type.Object({ completed: Type.Boolean() })),
  agent: Type.Optional(AgentConfigSchema),
  summary: Type.Optional(Type.String({ maxLength: 50_000 })),
  expectedRevision: Type.Number(),
  title: Type.Optional(Type.String({ maxLength: 500 })),
  text: Type.Optional(Type.String({ maxLength: 50_000 })),
  alt: Type.Optional(Type.String({ maxLength: 1000 })),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
});

export const MoveGraphOpBodySchema = Type.Object({
  kind: Type.Literal("move"),
  targetParentId: Type.String({ minLength: 1 }),
  moves: Type.Array(
    Type.Object({
      nodeId: Type.String({ minLength: 1 }),
      x: Type.Number(),
      y: Type.Number(),
      index: Type.Optional(Type.Integer({ minimum: 0 })),
      expectedLayoutVersion: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    { minItems: 1, maxItems: 500 },
  ),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
});

export const DeleteNodesGraphOpBodySchema = Type.Object({
  kind: Type.Literal("delete"),
  nodeIds: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: 500,
    uniqueItems: true,
  }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
});

export const SubmitGraphOpBodySchema = Type.Union([
  MoveGraphOpBodySchema,
  DeleteNodesGraphOpBodySchema,
]);

export const CreateLinkBodySchema = Type.Object({
  fromId: Type.String({ minLength: 1 }),
  toId: Type.String({ minLength: 1 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
});

export const DeleteLinkBodySchema = Type.Object({
  expectedRevision: Type.Number(),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
});

export const OperationIntentBodySchema = Type.Object({
  type: OperationTypeSchema,
  scopeId: Type.String({ minLength: 1 }),
  selection: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: 200,
    uniqueItems: true,
  }),
  includeDescendants: Type.Array(Type.String(), { maxItems: 200, uniqueItems: true }),
  includeConnected: Type.Boolean(),
  instruction: Type.String({ maxLength: 4000 }),
});

export const CreateOperationBodySchema = Type.Intersect([
  OperationIntentBodySchema,
  IdempotencyBodySchema,
]);

/** Ordered durable event envelope. BIGINT cursors remain decimal strings. */
export const StreamEventSchema = Type.Object({
  seq: Type.String({ pattern: "^[0-9]+$" }),
  type: Type.String(),
  payload: Type.Unknown(),
  attemptId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
