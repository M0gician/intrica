import type { ContextSnapshot, Node } from "@intrica/contracts";

/** 固定图快照：回放测试使用，避免 UI 测试受模型随机性影响。 */
export const fixtureNodes: Node[] = [
  {
    id: "root",
    canvasId: "root",
    layoutVersion: 0,
    sortKey: "0",
    contentLoaded: true,
    kind: "group",
    parentId: null,
    title: "根",
    position: { x: 0, y: 0, width: 0, height: 0 },
    childOrder: ["n-01", "n-02"],
    lifecycle: "committed",
    origin: "user",
    createdAt: "2026-09-04T08:00:00.000Z",
    revision: 1,
  },
  {
    id: "n-01",
    canvasId: "root",
    layoutVersion: 0,
    sortKey: "1",
    contentLoaded: true,
    kind: "text",
    parentId: "root",
    title: "假设",
    text: "竞品在 30 天内会把核心功能免费开放。",
    position: { x: 80, y: 80, width: 240, height: 160 },
    childOrder: [],
    lifecycle: "committed",
    origin: "user",
    createdAt: "2026-09-04T08:01:00.000Z",
    revision: 4,
  },
  {
    id: "n-02",
    canvasId: "root",
    layoutVersion: 0,
    sortKey: "2",
    contentLoaded: true,
    kind: "image",
    parentId: "root",
    title: "参考界面",
    assetId: "asset-07",
    assetVersion: 2,
    alt: "参考界面",
    position: { x: 400, y: 80, width: 240, height: 180 },
    childOrder: [],
    lifecycle: "committed",
    origin: "user",
    createdAt: "2026-09-04T08:02:00.000Z",
    revision: 1,
  },
];

export const fixtureEdges = [
  {
    id: "e-01",
    from: "n-01",
    to: "n-02",
    type: "user_link" as const,
    directed: false,
    confirmed: true,
    revision: 1,
    operationId: null,
    sourceRevision: null,
  },
];

/** 固定模型输出（MockRunner 与回放测试共用形状）。 */
export const modelOutputFixtures = {
  expand: {
    items: [
      { title: "可验证假设", text: "第一条结论……" },
      { title: "替代解释", text: "第二条结论……" },
    ],
  },
  deepen: {
    items: [{ title: "深入问题", text: "深入内容……" }],
  },
  compress: {
    items: [{ title: "研究方向", text: "候选摘要……" }],
  },
};

/** PRD §5 示例请求中的 contextSnapshot（逐字段摘抄）。 */
export const prdExampleContextSnapshot: ContextSnapshot = {
  snapshotVersion: 2,
  scope: { id: "root", kind: "group", title: "根", summary: "" },
  selection: ["n-01", "n-02"],
  contextOnlyNodeIds: [],
  nodes: [
    {
      id: "n-01",
      kind: "text",
      title: "假设",
      text: "……",
      revision: 4,
      containerPath: ["root"],
    },
    {
      id: "n-02",
      kind: "image",
      assetId: "asset-07",
      assetVersion: 2,
      alt: "参考界面",
      revision: 1,
      containerPath: ["root"],
    },
  ],
  edges: [
    {
      id: "e-01",
      from: "n-01",
      to: "n-02",
      type: "user_link",
      directed: false,
      confirmed: true,
      revision: 1,
      operationId: null,
      sourceRevision: null,
    },
  ],
  includeDescendants: [],
  omittedNodeIds: [],
  instruction: "提出一个可验证的下一步假设",
};
