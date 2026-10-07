import type { Node, Operation, SnapshotResponse } from "@intrica/contracts";
import type { Action } from "./actions";
import type { AppState, GraphState } from "./types";
import { initialGraphState } from "./types";

function patchGraph(state: AppState, patch: Partial<GraphState>): AppState {
  return { ...state, graph: { ...state.graph, ...patch } };
}

function mergeNode(previous: Node | undefined, next: Node): Node {
  if (!previous) return next;
  const content =
    next.revision < previous.revision
      ? previous
      : next.revision === previous.revision &&
          previous.contentLoaded &&
          next.contentLoaded === false
        ? {
            ...next,
            text: previous.text ?? "",
            summary: previous.summary ?? "",
            contentLoaded: true,
          }
        : next;
  if (next.layoutVersion < previous.layoutVersion)
    return {
      ...content,
      position: previous.position,
      parentId: previous.parentId,
      layoutVersion: previous.layoutVersion,
      sortKey: previous.sortKey,
    };
  return {
    ...content,
    position: next.position,
    parentId: next.parentId,
    layoutVersion: next.layoutVersion,
    sortKey: next.sortKey,
  };
}

function loadSnapshot(state: AppState, snapshot: SnapshotResponse): AppState {
  const nodes = new Map(
    snapshot.nodes.map((node) => [node.id, mergeNode(state.graph.nodes.get(node.id), node)]),
  );
  const measuredHeights = new Map([...state.graph.measuredHeights].filter(([id]) => nodes.has(id)));
  const edges = new Map(snapshot.edges.map((edge) => [edge.id, edge]));
  const operations = new Map(snapshot.operations.map((op) => [op.id, op]));
  const candidateNodes = new Map(snapshot.candidateNodes.map((node) => [node.id, node]));
  const candidateContainers = new Map(
    snapshot.candidateContainers.map((container) => [container.id, container]),
  );

  // 队列位次由快照内的 queued 操作按创建时间升序编号（服务端不在快照中携带位次）
  const queuePositions = new Map<string, number>();
  const queued = snapshot.operations
    .filter((op) => op.status === "queued")
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  queued.forEach((op, index) => {
    queuePositions.set(op.id, index + 1);
  });

  const graph: GraphState = {
    ...initialGraphState(),
    measuredHeights,
    nodes,
    edges,
    operations,
    candidateNodes,
    candidateContainers,
    graphRevision: snapshot.graphRevision,
    latestModelBatchAt: snapshot.latestModelBatchAt,
    latestModelBatchOperationId: snapshot.latestModelBatchOperationId,
    queuePositions,
    pendingEdges: state.graph.pendingEdges,
    pendingMoves: state.graph.pendingMoves,
  };

  const selection = new Set(
    [...state.view.selection].filter((id) => nodes.has(id)),
  ) as ReadonlySet<string>;

  let overlaySpace = state.view.overlaySpace;
  if (overlaySpace) {
    const exists = overlaySpace.readonly
      ? candidateContainers.has(overlaySpace.containerId) || nodes.has(overlaySpace.containerId)
      : nodes.has(overlaySpace.containerId);
    if (!exists) overlaySpace = null;
  }

  let panel = state.view.panel;
  if (panel?.type === "inspector" && panel.nodeId && !nodes.has(panel.nodeId))
    panel = { type: "inspector", nodeId: null };
  if (panel?.type === "review" && !operations.has(panel.operationId)) panel = null;

  let surface = state.view.surface;
  if (surface?.type === "nodeActions" && !nodes.has(surface.nodeId)) surface = null;
  if (surface?.type === "edgeActions" && !edges.has(surface.edgeId)) surface = null;
  if (surface?.type === "deleteConfirm") {
    const remaining = surface.nodeIds.filter((id) => nodes.has(id));
    surface = remaining.length > 0 ? { ...surface, nodeIds: remaining } : null;
  }

  return {
    graph,
    view: {
      ...state.view,
      baseScopeId: nodes.has(state.view.baseScopeId)
        ? state.view.baseScopeId
        : ([...nodes.values()].find((n) => n.parentId === null)?.id ?? ""),
      selection,
      overlaySpace,
      panel,
      surface,
    },
  };
}

function upsertOperation(
  state: AppState,
  operation: Operation,
  queuePosition: number | null,
): AppState {
  const operations = new Map(state.graph.operations);
  operations.set(operation.id, operation);
  const queuePositions = new Map(state.graph.queuePositions);
  if (queuePosition !== null) queuePositions.set(operation.id, queuePosition);
  else queuePositions.delete(operation.id);
  return patchGraph(state, { operations, queuePositions });
}

export function reduceGraph(state: AppState, action: Action): AppState | undefined {
  switch (action.type) {
    case "graphDelta": {
      if (
        action.delta.canvasId !== state.view.baseScopeId ||
        action.delta.graphRevision <= state.graph.graphRevision
      )
        return state;
      const nodes = new Map(state.graph.nodes);
      const edges = new Map(state.graph.edges);
      const scopes = new Set<string>();
      for (const node of action.delta.nodes) {
        if (node.parentId) scopes.add(node.parentId);
        const old = nodes.get(node.id);
        if (old?.parentId) scopes.add(old.parentId);
        scopes.add(node.id);
      }
      for (const id of action.delta.deletedNodeIds) {
        const old = nodes.get(id);
        if (old?.parentId) scopes.add(old.parentId);
        nodes.delete(id);
      }
      for (const node of action.delta.nodes)
        nodes.set(node.id, mergeNode(nodes.get(node.id), node));
      const children = new Map<string, Node[]>();
      for (const node of nodes.values())
        if (node.parentId && scopes.has(node.parentId)) {
          const list = children.get(node.parentId) ?? [];
          list.push(node);
          children.set(node.parentId, list);
        }
      for (const scope of scopes) {
        const parent = nodes.get(scope);
        if (!parent) continue;
        const ordered = (children.get(scope) ?? [])
          .sort((a, b) => {
            const x = BigInt(a.sortKey),
              y = BigInt(b.sortKey);
            return x < y ? -1 : x > y ? 1 : a.id.localeCompare(b.id);
          })
          .map((n) => n.id);
        if (
          ordered.length !== parent.childOrder.length ||
          ordered.some((id, i) => parent.childOrder[i] !== id)
        )
          nodes.set(scope, { ...parent, childOrder: ordered });
      }
      for (const id of action.delta.deletedEdgeIds) edges.delete(id);
      for (const edge of action.delta.edges) edges.set(edge.id, edge);
      const pendingMoves = new Map(state.graph.pendingMoves);
      const pendingEdges = new Map(state.graph.pendingEdges);
      if (action.delta.command) pendingMoves.delete(action.delta.command.requestId);
      if (action.delta.command) pendingEdges.delete(action.delta.command.requestId);
      const deleted = new Set(action.delta.deletedNodeIds);
      const selection = [...state.view.selection].some((id) => deleted.has(id))
        ? new Set([...state.view.selection].filter((id) => !deleted.has(id)))
        : state.view.selection;
      const panel = state.view.panel;
      return {
        ...state,
        graph: {
          ...state.graph,
          nodes,
          edges,
          pendingMoves,
          pendingEdges,
          graphRevision: Math.max(state.graph.graphRevision, action.delta.graphRevision),
          ...(action.delta.modelBatch
            ? {
                latestModelBatchAt: action.delta.modelBatch.committedAt,
                latestModelBatchOperationId: action.delta.modelBatch.operationId,
              }
            : {}),
        },
        view: {
          ...state.view,
          selection,
          panel:
            panel?.type === "inspector" && panel.nodeId && deleted.has(panel.nodeId)
              ? { type: "inspector", nodeId: null }
              : panel,
        },
      };
    }
    case "proposalLoaded": {
      if (action.operation.canvasId && action.operation.canvasId !== state.view.baseScopeId)
        return state;
      const candidateNodes = new Map(
        [...state.graph.candidateNodes].filter(([, n]) => n.operationId !== action.operation.id),
      );
      const candidateContainers = new Map(
        [...state.graph.candidateContainers].filter(
          ([, n]) => n.operationId !== action.operation.id,
        ),
      );
      for (const node of action.candidateNodes) candidateNodes.set(node.id, node);
      for (const node of action.candidateContainers) candidateContainers.set(node.id, node);
      return patchGraph(upsertOperation(state, action.operation, null), {
        candidateNodes,
        candidateContainers,
      });
    }
    case "snapshotLoaded":
      return loadSnapshot(state, action.snapshot);
    case "operationUpserted":
      if (action.operation.canvasId && action.operation.canvasId !== state.view.baseScopeId)
        return state;
      return upsertOperation(state, action.operation, action.queuePosition);
    case "nodeMeasured": {
      const node = state.graph.nodes.get(action.nodeId);
      if (
        node?.kind !== "todo" ||
        !Number.isFinite(action.height) ||
        action.height < 1 ||
        state.graph.measuredHeights.get(node.id) === action.height
      )
        return state;
      const measuredHeights = new Map(state.graph.measuredHeights).set(node.id, action.height);
      return patchGraph(state, { measuredHeights });
    }
    case "nodeContentLoaded": {
      const previous = state.graph.nodes.get(action.node.id);
      if (!previous) return state;
      if (
        action.node.canvasId &&
        action.node.parentId !== null &&
        action.node.canvasId !== state.view.baseScopeId
      )
        return state;
      const nodes = new Map(state.graph.nodes);
      // Content reads cannot change topology established by ordered graph commits.
      nodes.set(action.node.id, {
        ...mergeNode(previous, action.node),
        position: previous.position,
        parentId: previous.parentId,
        layoutVersion: previous.layoutVersion,
        sortKey: previous.sortKey,
        childOrder: previous.childOrder,
      });
      return patchGraph(state, {
        nodes,
      });
    }
    case "movePreviewAdded":
      return patchGraph(state, {
        pendingMoves: new Map(state.graph.pendingMoves).set(action.requestId, action.move),
      });
    case "movePreviewRemoved": {
      if (!state.graph.pendingMoves.has(action.requestId)) return state;
      const pendingMoves = new Map(state.graph.pendingMoves);
      pendingMoves.delete(action.requestId);
      return patchGraph(state, { pendingMoves });
    }
    case "linkPreviewAdded": {
      const pendingEdges = new Map(state.graph.pendingEdges);
      pendingEdges.set(action.edge.id, action.edge);
      return patchGraph(state, { pendingEdges });
    }
    case "linkPreviewRemoved": {
      if (!state.graph.pendingEdges.has(action.edgeId)) return state;
      const pendingEdges = new Map(state.graph.pendingEdges);
      pendingEdges.delete(action.edgeId);
      return patchGraph(state, { pendingEdges });
    }
  }
}
