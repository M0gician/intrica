import type { Rect } from "@intrica/contracts";
import { ROOT_NODE_ID } from "@intrica/contracts";
import { useCallback } from "react";
import { tr } from "../../i18n";
import { useStore } from "../../state/store";
import { type Displacement, MIN_ZOOM } from "../../state/types";
import { containerLayout } from "../../utils/container-layout";
import { displacementFor, rectsIntersect, unionRects } from "../../utils/geometry";
import type { CanvasCoordinates } from "./useCanvasCoordinates";

const OVERLAY_PADDING = 16,
  OVERLAY_HEADER_HEIGHT = 48,
  OVERLAY_GAP_PX = 24;
export type CanvasOverlay = ReturnType<typeof useCanvasOverlay>;
export function useCanvasOverlay({
  announce,
  viewportSize,
  applyTransform,
}: Pick<CanvasCoordinates, "viewportSize" | "applyTransform"> & {
  announce: (text: string) => void;
}) {
  const store = useStore();
  const openOverlay = useCallback(
    async (
      containerId: string,
      options?: {
        readonly?: boolean;
        operationId?: string | null;
      },
    ) => {
      const state = store.getState();
      const containerNode = state.graph.nodes.get(containerId);
      const candidateContainer = state.graph.candidateContainers.get(containerId);
      const anchorRect = containerNode?.position ?? candidateContainer?.position;
      if (!anchorRect) return;
      const readonly = options?.readonly ?? false;
      const items = readonly
        ? [...state.graph.candidateNodes.values()].filter(
            (node) =>
              node.parentId === containerId &&
              (!options?.operationId || node.operationId === options.operationId),
          )
        : (containerNode?.childOrder ?? []).flatMap((id) => {
            const node = state.graph.nodes.get(id);
            return node ? [node] : [];
          });
      const layout = readonly
        ? containerLayout(items, true)
        : new Map(items.map((node) => [node.id, node.position]));
      const content = unionRects([...layout.values()]);
      const width = Math.max(420, (content ? content.x + content.width : 0) + OVERLAY_PADDING * 2);
      const height = Math.max(
        260,
        (content ? content.y + content.height : 0) + OVERLAY_HEADER_HEIGHT + OVERLAY_PADDING * 2,
      );
      const bounds: Rect = {
        x: anchorRect.x + anchorRect.width + 32,
        y: Math.max(anchorRect.y - 16, 8),
        width,
        height,
      };
      const nextDisplacement = new Map<string, Displacement>();
      for (const node of state.graph.nodes.values()) {
        if (node.parentId !== state.view.baseScopeId || node.id === ROOT_NODE_ID) continue;
        if (rectsIntersect(node.position, bounds)) {
          nextDisplacement.set(node.id, displacementFor(node.position, bounds, OVERLAY_GAP_PX));
        }
      }
      store.dispatch({
        type: "overlayOpened",
        overlay: {
          containerId,
          readonly,
          previewOperationId: options?.operationId ?? null,
          bounds,
          displacement: nextDisplacement,
        },
      });
      // Keep the first content area visible beside the inspector. Large spaces stay pannable.
      const { pan, zoom: currentZoom } = store.getState().view;
      const viewport = viewportSize();
      const zoom = Math.min(currentZoom, Math.max(MIN_ZOOM, (viewport.width - 32) / bounds.width));
      const x = Math.max(
        16,
        Math.min(
          viewport.width - 16 - Math.min(bounds.width * zoom, viewport.width - 32),
          bounds.x * zoom + pan.x,
        ),
      );
      const y = Math.max(
        70,
        Math.min(
          viewport.height - 60 - Math.min(bounds.height * zoom, viewport.height - 130),
          bounds.y * zoom + pan.y,
        ),
      );
      applyTransform({ x: x - bounds.x * zoom, y: y - bounds.y * zoom }, zoom);
      const title = containerNode?.title ?? candidateContainer?.title ?? tr("未命名");
      announce(
        readonly
          ? tr("已打开候选预览空间：{{v0}}", { v0: title })
          : tr("已打开临时内部空间：{{v0}}", { v0: title }),
      );
    },
    [announce, viewportSize, applyTransform, store.dispatch, store.getState],
  );
  const closeOverlay = useCallback(() => {
    store.dispatch({ type: "overlayClosed" });
    announce(tr("已关闭临时内部空间"));
  }, [announce, store.dispatch]);
  const moveOverlay = useCallback(
    (bounds: Rect) => {
      store.dispatch({ type: "overlayMoved", bounds });
    },
    [store.dispatch],
  );

  return { openOverlay, closeOverlay, moveOverlay };
}
