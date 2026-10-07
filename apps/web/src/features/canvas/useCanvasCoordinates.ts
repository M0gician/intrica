import type { Rect } from "@intrica/contracts";
import { type RefObject, useCallback } from "react";
import { useStore } from "../../state/store";
import { MAX_ZOOM, MIN_ZOOM } from "../../state/types";
import { ensureBoundsVisible } from "../../utils/geometry";

const FIT_MARGIN_PX = 64;
export type CanvasCoordinates = ReturnType<typeof useCanvasCoordinates>;
export function useCanvasCoordinates(viewportRef: RefObject<HTMLDivElement | null>) {
  const store = useStore();
  const toWorld = useCallback(
    (clientX: number, clientY: number) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      const { pan, zoom } = store.getState().view;
      return {
        x: (clientX - (rect?.left ?? 0) - pan.x) / zoom,
        y: (clientY - (rect?.top ?? 0) - pan.y) / zoom,
      };
    },
    [store.getState, viewportRef.current?.getBoundingClientRect],
  );
  const toScreenRect = useCallback(
    (world: Rect): Rect => {
      const rect = viewportRef.current?.getBoundingClientRect();
      const { pan, zoom } = store.getState().view;
      return {
        x: (rect?.left ?? 0) + pan.x + world.x * zoom,
        y: (rect?.top ?? 0) + pan.y + world.y * zoom,
        width: world.width * zoom,
        height: world.height * zoom,
      };
    },
    [store.getState, viewportRef.current?.getBoundingClientRect],
  );
  const viewportSize = useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const panel = viewportRef.current?.querySelector(".workspace-panel");
    return {
      width: Math.max(1, (rect?.width ?? 0) - (panel?.getBoundingClientRect().width ?? 0)),
      height: rect?.height ?? 0,
    };
  }, [viewportRef.current?.querySelector, viewportRef.current?.getBoundingClientRect]);
  const zoomAtPoint = useCallback(
    (factor: number, px: number, py: number) => {
      const { pan, zoom } = store.getState().view;
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
      const k = next / zoom;
      store.dispatch({
        type: "viewTransformChanged",
        zoom: next,
        pan: { x: px - (px - pan.x) * k, y: py - (py - pan.y) * k },
      });
    },
    [store.dispatch, store.getState],
  );
  const applyTransform = useCallback(
    (
      pan: {
        x: number;
        y: number;
      },
      zoom: number,
    ) => {
      store.dispatch({ type: "viewTransformChanged", pan, zoom });
    },
    [store.dispatch],
  );
  const ensureWorldBoundsVisible = useCallback(
    (bounds: Rect | null) => {
      if (!bounds) return;
      const { pan, zoom } = store.getState().view;
      const next = ensureBoundsVisible(
        pan,
        zoom,
        viewportSize(),
        bounds,
        FIT_MARGIN_PX,
        MIN_ZOOM,
        MAX_ZOOM,
      );
      if (next) applyTransform(next.pan, next.zoom);
    },
    [applyTransform, viewportSize, store.getState],
  );

  return {
    toWorld,
    toScreenRect,
    viewportSize,
    zoomAtPoint,
    applyTransform,
    ensureWorldBoundsVisible,
  };
}
