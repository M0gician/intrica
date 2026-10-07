import type { ContextSnapshot, Edge, Node, Operation } from "@intrica/contracts";

export function makeNode(overrides: Partial<Node> & { id: string }): Node {
  return {
    canvasId: "root",
    layoutVersion: 0,
    sortKey: "0",
    contentLoaded: true,
    kind: "text",
    parentId: "root",
    title: overrides.id,
    position: { x: 0, y: 0, width: 240, height: 160 },
    childOrder: [],
    lifecycle: "committed",
    origin: "user",
    createdAt: "2026-09-04T08:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

export function makeEdge(overrides: Partial<Edge> & { id: string }): Edge {
  return {
    from: "a",
    to: "b",
    type: "user_link",
    directed: false,
    confirmed: true,
    revision: 1,
    operationId: null,
    sourceRevision: null,
    ...overrides,
  };
}

export function makeContextSnapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    snapshotVersion: 2,
    scope: { id: "root", kind: "group", title: "根" },
    selection: [],
    contextOnlyNodeIds: [],
    nodes: [],
    edges: [],
    includeDescendants: [],
    omittedNodeIds: [],
    instruction: "",
    ...overrides,
  };
}

export function makeOperation(overrides: Partial<Operation> & { id: string }): Operation {
  return {
    type: "expand",
    scopeId: "root",
    placementMode: "sibling",
    selection: [],
    outputParentId: "root",
    resultContainerParentId: null,
    resultContainerId: null,
    resultContainerState: "none",
    outputIds: [],
    instruction: "",
    status: "queued",
    undone: false,
    createdAt: "2026-09-04T09:00:00.000Z",
    ...overrides,
  };
}
