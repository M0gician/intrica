import type * as React from "react";
import { useCallback } from "react";
import { useStore } from "../../state/store";
import { normalizeMarquee, rectsIntersect } from "../../utils/geometry";
import { startPointerSession } from "./pointer-session";
import type { CanvasCoordinates } from "./useCanvasCoordinates";
import type { CanvasOverlay } from "./useCanvasOverlay";
import type { CanvasScene } from "./useCanvasScene";
import type { CanvasSelection } from "./useCanvasSelection";

type Input = Pick<CanvasScene, "baseNodes" | "baseEdgeRects"> &
  Pick<CanvasCoordinates, "toWorld"> &
  Pick<CanvasSelection, "applySelection"> &
  Pick<CanvasOverlay, "closeOverlay"> & {
    viewportRef: React.RefObject<HTMLDivElement | null>;
    closeSurface: () => void;
  };
const MARQUEE_THRESHOLD_PX = 4;
export function useCanvasMarquee({
  baseNodes,
  baseEdgeRects,
  toWorld,
  applySelection,
  closeOverlay,
  viewportRef,
  closeSurface,
}: Input) {
  const store = useStore();
  const handleViewportPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (
        target.closest(
          "[data-canvas-ui], [data-node-id], [data-canvas-edge], [data-canvas-overlay]",
        )
      )
        return;
      viewportRef.current?.focus();
      if (event.button !== 0) return;
      const downWorld = toWorld(event.clientX, event.clientY);
      const downClient = { x: event.clientX, y: event.clientY };
      const activeOverlay = store.getState().view.overlaySpace;
      const allowMarquee = !activeOverlay?.readonly;
      let marqueeActive = false;
      startPointerSession({
        pointerId: event.pointerId,
        onMove: (moveEvent) => {
          if (!allowMarquee) return;
          const distance = Math.hypot(
            moveEvent.clientX - downClient.x,
            moveEvent.clientY - downClient.y,
          );
          if (!marqueeActive && distance <= MARQUEE_THRESHOLD_PX) return;
          marqueeActive = true;
          const current = toWorld(moveEvent.clientX, moveEvent.clientY);
          store.dispatch({
            type: "marqueeChanged",
            marquee: { x1: downWorld.x, y1: downWorld.y, x2: current.x, y2: current.y },
          });
        },
        onUp: (upEvent) => {
          store.dispatch({ type: "marqueeChanged", marquee: null });
          if (marqueeActive) {
            const current = toWorld(upEvent.clientX, upEvent.clientY);
            const rect = normalizeMarquee({
              x1: downWorld.x,
              y1: downWorld.y,
              x2: current.x,
              y2: current.y,
            });
            const state = store.getState();
            const selected = new Set<string>(event.shiftKey ? state.view.selection : []);
            for (const node of baseNodes) {
              const nodeRect = baseEdgeRects.get(node.id)!;
              if (rectsIntersect(nodeRect, rect)) selected.add(node.id);
            }
            applySelection(selected);
          } else if (store.getState().view.overlaySpace) {
            // 空间打开时：点击空间外空白只关闭空间并吞掉本次点击
            closeOverlay();
          } else {
            // 空白单击：只取消选择并关闭浮层（规范 §4，不再打开新建菜单）
            closeSurface();
            applySelection(new Set());
          }
        },
        onCancel: () => {
          store.dispatch({ type: "marqueeChanged", marquee: null });
        },
      });
    },
    [
      applySelection,
      baseNodes,
      baseEdgeRects,
      closeOverlay,
      closeSurface,
      toWorld,
      store.getState,
      store.dispatch,
      viewportRef,
    ],
  );
  const handleViewportDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (
        target.closest(
          "[data-canvas-ui], [data-node-id], [data-canvas-edge], [data-canvas-overlay-header]",
        )
      )
        return;
      const point = toWorld(event.clientX, event.clientY);
      store.dispatch({ type: "surfaceOpened", surface: { type: "create", position: point } });
    },
    [toWorld, store.dispatch],
  );

  return { handleViewportPointerDown, handleViewportDoubleClick };
}
