import type { Node, Rect } from "@intrica/contracts";
import { CONTAINER_PADDING } from "@intrica/contracts";
import type * as React from "react";
import { useCallback, useMemo } from "react";
import { tr } from "../../i18n";
import type { WorkspaceController } from "../../state/controller";
import { useStore } from "../../state/store";
import type { DragState, DropTarget, OverlaySpaceState } from "../../state/types";
import { pointInRect, unionRects } from "../../utils/geometry";
import { commonScopeId, findAncestorConflict } from "../../utils/graph";
import { startPointerSession } from "./pointer-session";
import { orderedChildren } from "./scene";
import { SpatialIndex } from "./spatial-index";

const OVERLAY_PADDING = 16,
  OVERLAY_HEADER_HEIGHT = 48,
  DRAG_THRESHOLD_PX = 8;
export function useNodeDrag({
  controller,
  announce,
  overlayOrigin,
  ensureWorldBoundsVisible,
  closeSurface,
  applySelection,
  toWorld,
  nodes,
  baseScopeId,
  overlay,
}: {
  controller: WorkspaceController;
  announce: (message: string) => void;
  overlayOrigin: {
    x: number;
    y: number;
  } | null;
  ensureWorldBoundsVisible: (rect: Rect | null) => void;
  closeSurface: () => void;
  applySelection: (selection: ReadonlySet<string>) => void;
  toWorld: (
    x: number,
    y: number,
  ) => {
    x: number;
    y: number;
  };
  nodes: ReadonlyMap<string, Node>;
  baseScopeId: string;
  overlay: OverlaySpaceState | null;
}) {
  const store = useStore();
  const baseItems = useMemo(
    () =>
      orderedChildren(nodes, baseScopeId).map((n) => {
        const d = overlay?.displacement.get(n.id);
        return d
          ? { ...n, position: { ...n.position, x: n.position.x + d.dx, y: n.position.y + d.dy } }
          : n;
      }),
    [nodes, baseScopeId, overlay?.displacement],
  );
  const baseIndex = useMemo(() => new SpatialIndex(baseItems), [baseItems]);
  const rank = useMemo(() => new Map(baseItems.map((n, i) => [n.id, i])), [baseItems]);
  const overlayId = overlay?.containerId;
  const overlayReadonly = overlay?.readonly === true;
  const overlayIndex = useMemo(
    () => new SpatialIndex(overlayId && !overlayReadonly ? orderedChildren(nodes, overlayId) : []),
    [nodes, overlayId, overlayReadonly],
  );
  const commitDrop = useCallback(
    (drag: DragState) => {
      const state = store.getState();
      const { nodes } = state.graph;
      const target = drag.target;
      if (!target) return;
      if (target.kind === "invalid") {
        announce(target.reason);
        return;
      }
      const primaryId = drag.nodeIds[0];
      if (!primaryId) return;
      const primary = nodes.get(primaryId);
      if (!primary) return;
      const baseScopeId = state.view.baseScopeId;
      const currentOverlay = state.view.overlaySpace;
      const finish = (
        targetParentId: string,
        moves: Array<{
          nodeId: string;
          x: number;
          y: number;
        }>,
      ) => {
        void controller.commitMove(targetParentId, moves).then((ok) => {
          if (!ok) return;
          const latest = store.getState().graph;
          const rects = moves.flatMap((move) => {
            const node = latest.nodes.get(move.nodeId);
            if (!node) return [];
            if (node.parentId === baseScopeId) return [node.position];
            if (currentOverlay && overlayOrigin && node.parentId === currentOverlay.containerId) {
              return [
                {
                  x: overlayOrigin.x + node.position.x,
                  y: overlayOrigin.y + node.position.y,
                  width: node.position.width,
                  height: node.position.height,
                },
              ];
            }
            return [];
          });
          ensureWorldBoundsVisible(unionRects(rects));
        });
      };
      if (target.kind === "node") {
        const targetNode = nodes.get(target.nodeId);
        if (!targetNode) return;
        const moves = drag.nodeIds.flatMap((id) => {
          const node = nodes.get(id);
          if (!node) return [];
          return [
            {
              nodeId: id,
              x: CONTAINER_PADDING + (node.position.x - primary.position.x),
              y: CONTAINER_PADDING + (node.position.y - primary.position.y),
            },
          ];
        });
        finish(target.nodeId, moves);
        return;
      }
      const scopeId = target.scopeId;
      if (
        scopeId === primary.parentId &&
        Math.hypot(drag.delta.x, drag.delta.y) < 1 &&
        drag.nodeIds.every((id) => nodes.get(id)?.parentId === scopeId)
      ) {
        return;
      }
      const origin =
        currentOverlay && scopeId === currentOverlay.containerId
          ? {
              x: currentOverlay.bounds.x + OVERLAY_PADDING,
              y: currentOverlay.bounds.y + OVERLAY_HEADER_HEIGHT + OVERLAY_PADDING,
            }
          : null;
      const outOrigin = currentOverlay
        ? {
            x: currentOverlay.bounds.x + OVERLAY_PADDING,
            y: currentOverlay.bounds.y + OVERLAY_HEADER_HEIGHT + OVERLAY_PADDING,
          }
        : null;
      const moves = drag.nodeIds.flatMap((id) => {
        const node = nodes.get(id);
        if (!node) return [];
        let x: number;
        let y: number;
        if (scopeId === baseScopeId) {
          if (node.parentId === baseScopeId) {
            x = node.position.x + drag.delta.x;
            y = node.position.y + drag.delta.y;
          } else if (outOrigin) {
            x = outOrigin.x + node.position.x + drag.delta.x;
            y = outOrigin.y + node.position.y + drag.delta.y;
          } else {
            x = node.position.x + drag.delta.x;
            y = node.position.y + drag.delta.y;
          }
        } else if (origin) {
          if (node.parentId === baseScopeId) {
            const disp = currentOverlay?.displacement.get(id);
            x = node.position.x + (disp?.dx ?? 0) + drag.delta.x - origin.x;
            y = node.position.y + (disp?.dy ?? 0) + drag.delta.y - origin.y;
          } else {
            x = node.position.x + drag.delta.x;
            y = node.position.y + drag.delta.y;
          }
        } else {
          x = node.position.x + drag.delta.x;
          y = node.position.y + drag.delta.y;
        }
        return [{ nodeId: id, x: Math.round(x), y: Math.round(y) }];
      });
      finish(scopeId, moves);
    },
    [announce, controller, ensureWorldBoundsVisible, overlayOrigin, store.getState],
  );
  const computeDropTarget = useCallback(
    (
      point: {
        x: number;
        y: number;
      },
      draggedIds: string[],
      dragged: ReadonlySet<string>,
      detach = false,
    ): DropTarget => {
      const state = store.getState();
      const currentOverlay = state.view.overlaySpace;
      const nodeTarget = (targetId: string): DropTarget => {
        let current: string | null = targetId;
        while (current) {
          if (dragged.has(current)) {
            return {
              kind: "invalid",
              reason: tr("不能移动到节点自身或其后代内部"),
            };
          }
          current = nodes.get(current)?.parentId ?? null;
        }
        return { kind: "node", nodeId: targetId };
      };
      if (currentOverlay && !currentOverlay.readonly) {
        const origin = {
          x: currentOverlay.bounds.x + OVERLAY_PADDING,
          y: currentOverlay.bounds.y + OVERLAY_HEADER_HEIGHT + OVERLAY_PADDING,
        };
        for (const node of overlayIndex.query({
          x: point.x - origin.x,
          y: point.y - origin.y,
          width: 0,
          height: 0,
        })) {
          if (node.parentId !== currentOverlay.containerId || dragged.has(node.id)) continue;
          const rect: Rect = {
            x: origin.x + node.position.x,
            y: origin.y + node.position.y,
            width: node.position.width,
            height: node.position.height,
          };
          if (pointInRect(point, rect)) return nodeTarget(node.id);
        }
        if (
          pointInRect(point, currentOverlay.bounds) ||
          (!detach &&
            draggedIds.every((id) => nodes.get(id)?.parentId === currentOverlay.containerId))
        ) {
          return { kind: "scope", scopeId: currentOverlay.containerId };
        }
      }
      const hits = baseIndex
        .query({ ...point, width: 0, height: 0 })
        .sort((a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0));
      for (const node of hits) if (!dragged.has(node.id)) return nodeTarget(node.id);
      return { kind: "scope", scopeId: state.view.baseScopeId };
    },
    [nodes, baseIndex, overlayIndex, rank, store.getState],
  );
  const handleHeaderPointerDown = useCallback(
    (nodeId: string, event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey) return;
      closeSurface();
      const state = store.getState();
      const { nodes } = state.graph;
      if (!nodes.has(nodeId)) return;
      let draggedIds: string[];
      if (state.view.selection.has(nodeId)) {
        draggedIds = [...state.view.selection];
      } else {
        draggedIds = [nodeId];
        applySelection(new Set([nodeId]));
      }
      if (findAncestorConflict(nodes, new Set(draggedIds))) {
        announce(tr("选区同时包含父节点及其后代，无法拖动，请改为只选择父节点或只选择后代"));
        return;
      }
      const parents = new Set(draggedIds.map((id) => nodes.get(id)?.parentId ?? null));
      if (parents.size > 1) {
        announce(tr("只能同时移动同一层级的节点"));
        return;
      }
      const originScopeId = nodes.get(nodeId)?.parentId ?? state.view.baseScopeId;
      const dragged = new Set(draggedIds);
      const startClient = { x: event.clientX, y: event.clientY };
      let active = false;
      startPointerSession({
        pointerId: event.pointerId,
        onMove: (moveEvent) => {
          const dx = moveEvent.clientX - startClient.x;
          const dy = moveEvent.clientY - startClient.y;
          if (!active && Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return;
          active = true;
          const { zoom } = store.getState().view;
          const delta = { x: dx / zoom, y: dy / zoom };
          const pointer = toWorld(moveEvent.clientX, moveEvent.clientY);
          const target = computeDropTarget(pointer, draggedIds, dragged, moveEvent.altKey);
          store.dispatch({
            type: "dragChanged",
            drag: { nodeIds: draggedIds, originScopeId, delta, target, active: true },
          });
        },
        onUp: () => {
          const drag = store.getState().view.drag;
          store.dispatch({ type: "dragChanged", drag: null });
          if (active && drag) commitDrop(drag);
        },
        onCancel: () => {
          store.dispatch({ type: "dragChanged", drag: null });
        },
      });
    },
    [
      announce,
      applySelection,
      closeSurface,
      commitDrop,
      computeDropTarget,
      toWorld,
      store.getState,
      store.dispatch,
    ],
  );
  const commitNudge = useCallback(() => {
    const state = store.getState();
    const nudge = state.view.nudge;
    if (!nudge) return;
    store.dispatch({ type: "nudgeChanged", nudge: null });
    const { nodes } = state.graph;
    const selection = state.view.selection;
    if (selection.size === 0) return;
    const scopeId = commonScopeId(nodes, selection);
    if (!scopeId) {
      announce(tr("方向键微移只支持同一层级的选区"));
      return;
    }
    const moves = [...selection].flatMap((id) => {
      const node = nodes.get(id);
      if (!node) return [];
      return [{ nodeId: id, x: node.position.x + nudge.dx, y: node.position.y + nudge.dy }];
    });
    void controller.commitMove(scopeId, moves);
  }, [announce, controller, store.getState, store.dispatch]);
  return { handleHeaderPointerDown, commitNudge };
}
