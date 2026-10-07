import type { Node, Rect } from "@intrica/contracts";
import { useCallback, useMemo } from "react";
import type { Displacement, GraphState, ViewState } from "../../state/types";
import { containerBounds, containerLayout } from "../../utils/container-layout";
import { RectMap } from "./rect-map";
import { crossScopeCounts, orderedChildren, SceneProjection } from "./scene";
import { useScopeConnections } from "./useScopeConnections";

const EMPTY_DISPLACEMENT: ReadonlyMap<string, Displacement> = new Map();
const OVERLAY_PADDING = 16,
  OVERLAY_HEADER_HEIGHT = 48;
export type CanvasScene = ReturnType<typeof useCanvasScene>;
export function useCanvasScene(storedGraph: GraphState, view: ViewState) {
  const projection = useMemo(() => new SceneProjection(), []);
  const scene = useMemo(
    () => projection.project(storedGraph.nodes, storedGraph.measuredHeights),
    [projection, storedGraph.nodes, storedGraph.measuredHeights],
  );
  const graph = useMemo(() => ({ ...storedGraph, nodes: scene.nodes }), [storedGraph, scene]);
  const crossCounts = useMemo(
    () => crossScopeCounts(graph.nodes, graph.edges),
    [graph.nodes, graph.edges],
  );
  const overlay = view.overlaySpace;
  const overlayId = overlay?.containerId;
  const overlayReadonly = overlay?.readonly === true;
  const previewOperationId = overlay?.previewOperationId;
  const displacement = overlay?.displacement ?? EMPTY_DISPLACEMENT;
  const baseNodes = useMemo(
    () => orderedChildren(graph.nodes, view.baseScopeId),
    [graph.nodes, view.baseScopeId],
  );
  const overlayChildren = useMemo(
    () => (overlayId && !overlayReadonly ? orderedChildren(graph.nodes, overlayId) : []),
    [graph.nodes, overlayId, overlayReadonly],
  );
  const overlayCandidateChildren = useMemo(() => {
    if (!overlayReadonly) return [];
    return [...graph.candidateNodes.values()].filter(
      (candidate) =>
        candidate.parentId === overlayId &&
        (previewOperationId === null || candidate.operationId === previewOperationId),
    );
  }, [graph.candidateNodes, overlayReadonly, overlayId, previewOperationId]);
  const overlayScopeCandidates = useMemo(() => {
    if (!overlayId || overlayReadonly) return [];
    return [...graph.candidateNodes.values()].filter(
      (candidate) => candidate.parentId === overlayId,
    );
  }, [graph.candidateNodes, overlayId, overlayReadonly]);
  const overlayScopeCandidateContainers = useMemo(() => {
    if (!overlayId || overlayReadonly) return [];
    return [...graph.candidateContainers.values()].filter(
      (container) => container.parentId === overlayId,
    );
  }, [graph.candidateContainers, overlayId, overlayReadonly]);
  const overlayOrigin = useMemo(() => {
    if (!overlay) return null;
    return {
      x: overlay.bounds.x + OVERLAY_PADDING,
      y: overlay.bounds.y + OVERLAY_HEADER_HEIGHT + OVERLAY_PADDING,
    };
  }, [overlay]);
  const candidatePreviewLayout = useMemo(
    () => containerLayout(overlayCandidateChildren, true),
    [overlayCandidateChildren],
  );
  const baseCandidates = useMemo(
    () =>
      [...graph.candidateNodes.values()].filter(
        (candidate) => candidate.parentId === view.baseScopeId,
      ),
    [graph.candidateNodes, view.baseScopeId],
  );
  const baseCandidateContainers = useMemo(
    () =>
      [...graph.candidateContainers.values()].filter(
        (container) =>
          container.parentId === view.baseScopeId && container.projection === "readonly_canvas",
      ),
    [graph.candidateContainers, view.baseScopeId],
  );
  const candidateStatusByOp = useMemo(() => {
    const map = new Map<string, "running" | "candidate">();
    for (const operation of graph.operations.values()) {
      map.set(operation.id, operation.status === "candidate" ? "candidate" : ("running" as const));
    }
    return map;
  }, [graph.operations]);
  const generatingNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const candidate of graph.candidateNodes.values()) {
      if (candidate.parentId === view.baseScopeId) continue;
      if (candidate.parentId === overlayId) continue;
      if (graph.candidateContainers.has(candidate.parentId)) continue;
      const operation = graph.operations.get(candidate.operationId);
      if (!operation) continue;
      if (operation.status === "running" || operation.status === "queued") {
        ids.add(candidate.parentId);
      }
    }
    return ids;
  }, [
    graph.candidateNodes,
    graph.candidateContainers,
    graph.operations,
    view.baseScopeId,
    overlayId,
  ]);
  const displacedRect = useCallback(
    (node: Node): Rect => {
      const disp = displacement.get(node.id);
      return {
        x: node.position.x + (disp?.dx ?? 0),
        y: node.position.y + (disp?.dy ?? 0),
        width: node.position.width,
        height: node.position.height,
      };
    },
    [displacement],
  );
  const baseRects = useMemo(
    () => new Map(baseNodes.map((node) => [node.id, displacedRect(node)])),
    [baseNodes, displacedRect],
  );
  const overlayRects = useMemo(
    () => new Map(overlayChildren.map((node) => [node.id, node.position])),
    [overlayChildren],
  );
  const draggedIds = useMemo(() => new Set(view.drag?.nodeIds), [view.drag?.nodeIds]);
  const transform = useCallback(
    (id: string, rect: Rect) => {
      const drag = view.drag?.active && draggedIds.has(id) ? view.drag.delta : null;
      const nudge = view.nudge && view.selection.has(id) ? view.nudge : null;
      return drag || nudge
        ? {
            ...rect,
            x: rect.x + (drag?.x ?? 0) + (nudge?.dx ?? 0),
            y: rect.y + (drag?.y ?? 0) + (nudge?.dy ?? 0),
          }
        : rect;
    },
    [view.drag, draggedIds, view.nudge, view.selection],
  );
  const baseEdgeRects = useMemo(() => new RectMap(baseRects, transform), [baseRects, transform]);
  const overlayEdgeRects = useMemo(
    () => new RectMap(overlayRects, transform),
    [overlayRects, transform],
  );
  const visibleOverlay = useMemo(
    () =>
      overlay && !overlay.readonly
        ? { ...overlay, bounds: containerBounds(overlay.bounds, overlayEdgeRects.values()) }
        : overlay,
    [overlay, overlayEdgeRects],
  );
  const overlayEdgeWorldRects = useMemo(
    () =>
      new RectMap(overlayEdgeRects, (_id, rect) => ({
        ...rect,
        x: rect.x + (overlayOrigin?.x ?? 0),
        y: rect.y + (overlayOrigin?.y ?? 0),
      })),
    [overlayEdgeRects, overlayOrigin],
  );

  const baseConnections = useScopeConnections(graph.nodes, graph.edges, baseRects, baseEdgeRects);
  const overlayConnections = useScopeConnections(
    graph.nodes,
    graph.edges,
    overlayRects,
    overlayEdgeRects,
    true,
  );
  return {
    graph,
    scene,
    crossCounts,
    overlay,
    readonlyOverlay: overlay?.readonly === true,
    displacement,
    baseNodes,
    overlayChildren,
    overlayCandidateChildren,
    overlayScopeCandidates,
    overlayScopeCandidateContainers,
    overlayOrigin,
    candidatePreviewLayout,
    baseCandidates,
    baseCandidateContainers,
    candidateStatusByOp,
    generatingNodeIds,
    displacedRect,
    baseEdgeRects,
    overlayEdgeRects,
    visibleOverlay,
    overlayEdgeWorldRects,
    baseConnections,
    overlayConnections,
    draggedIds,
    baseRects,
    overlayRects,
  };
}
