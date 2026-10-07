import type * as React from "react";
import { useCallback, useEffect, useRef } from "react";
import { matchesShortcut, useShortcuts } from "../../app/shortcuts";
import type { WorkspaceController } from "../../state/controller";
import { useStore } from "../../state/store";
import type { CanvasCommands } from "./useCanvasCommands";
import type { CanvasCoordinates } from "./useCanvasCoordinates";
import type { CanvasLinks } from "./useCanvasLinks";
import type { CanvasOverlay } from "./useCanvasOverlay";
import type { CanvasSelection } from "./useCanvasSelection";

type Input = Pick<CanvasSelection, "applySelection"> &
  Pick<CanvasOverlay, "openOverlay" | "closeOverlay"> &
  Pick<CanvasLinks, "changeLink" | "linkRef" | "setHoverEdge"> &
  Pick<CanvasCommands, "requestDeleteNodes"> &
  Pick<CanvasCoordinates, "zoomAtPoint"> & {
    controller: WorkspaceController;
    closeSurface: () => void;
    commitNudge: () => void;
    viewportRef: React.RefObject<HTMLDivElement | null>;
  };
const NUDGE_STEP_PX = 8,
  NUDGE_COMMIT_DELAY_MS = 400;
export function useCanvasKeyboard({
  controller,
  applySelection,
  closeOverlay,
  openOverlay,
  changeLink,
  linkRef,
  setHoverEdge,
  requestDeleteNodes,
  zoomAtPoint,
  closeSurface,
  commitNudge,
  viewportRef,
}: Input) {
  const store = useStore();
  const shortcuts = useShortcuts();
  const nudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
    },
    [],
  );
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (event.defaultPrevented || event.nativeEvent.isComposing) return;
      const inField = target.closest("input, textarea, [contenteditable]") !== null;
      const currentView = store.getState().view;
      const isReadonly = currentView.overlaySpace?.readonly === true;
      if (
        matchesShortcut(shortcuts, "selectAllNodes", event) &&
        !inField &&
        !target.closest("[data-canvas-ui]")
      ) {
        event.preventDefault();
        const scopeId = currentView.overlaySpace?.readonly
          ? null
          : (currentView.overlaySpace?.containerId ?? currentView.baseScopeId);
        if (scopeId)
          applySelection(
            new Set(
              [...store.getState().graph.nodes.values()]
                .filter((node) => node.parentId === scopeId)
                .map((node) => node.id),
            ),
          );
        return;
      }
      if (matchesShortcut(shortcuts, "undoCanvas", event)) {
        if (inField || target.closest("[data-canvas-ui]")) return;
        if (isReadonly) return;
        event.preventDefault();
        void controller.undoWorkspace();
        return;
      }
      if (event.key === "Escape") {
        setHoverEdge(null);
        if (linkRef.current) {
          changeLink(null);
          return;
        }
        if (inField) {
          (target as HTMLInputElement | HTMLTextAreaElement).blur();
          return;
        }
        // Esc 层级：编辑字段 → 浮层 → 详情侧栏 → 临时空间 → 选区
        if (currentView.surface) closeSurface();
        else if (currentView.panel) store.dispatch({ type: "panelClosed" });
        else if (currentView.overlaySpace) closeOverlay();
        else if (currentView.selection.size > 0) applySelection(new Set());
        return;
      }
      if (
        inField ||
        target.closest("[data-canvas-ui]") ||
        document.activeElement?.closest("[data-canvas-ui]")
      )
        return;
      if (event.code === "Space" && !target.closest("button, a, summary")) {
        event.preventDefault();
        return;
      }
      if (
        matchesShortcut(shortcuts, "deleteSelected", event) &&
        currentView.selection.size > 0 &&
        currentView.surface?.type !== "edgeActions"
      ) {
        event.preventDefault();
        requestDeleteNodes([...currentView.selection]);
        return;
      }
      if (
        matchesShortcut(shortcuts, "deleteSelected", event) &&
        store.getState().view.surface?.type === "edgeActions"
      ) {
        event.preventDefault();
        const current = store.getState().view.surface;
        if (current?.type === "edgeActions") {
          const edge = store.getState().graph.edges.get(current.edgeId);
          closeSurface();
          if (edge) void controller.deleteLink(edge);
        }
        return;
      }
      if (matchesShortcut(shortcuts, "zoomIn", event)) {
        event.preventDefault();
        const rect = viewportRef.current?.getBoundingClientRect();
        zoomAtPoint(1.2, (rect?.width ?? 0) / 2, (rect?.height ?? 0) / 2);
        return;
      }
      if (matchesShortcut(shortcuts, "zoomOut", event)) {
        event.preventDefault();
        const rect = viewportRef.current?.getBoundingClientRect();
        zoomAtPoint(1 / 1.2, (rect?.width ?? 0) / 2, (rect?.height ?? 0) / 2);
        return;
      }
      // 只读候选预览空间：屏蔽微移/打开空间等结构操作
      if (isReadonly) return;
      if (matchesShortcut(shortcuts, "openNode", event)) {
        const selection = store.getState().view.selection;
        if (selection.size === 1) {
          const nodeId = [...selection][0];
          const node = nodeId ? store.getState().graph.nodes.get(nodeId) : undefined;
          if (node && node.childOrder.length > 0) {
            event.preventDefault();
            if (store.getState().view.overlaySpace?.containerId === node.id) closeOverlay();
            else openOverlay(node.id);
          }
        }
        return;
      }
      const direction = (["moveLeft", "moveRight", "moveUp", "moveDown"] as const).find((action) =>
        matchesShortcut(shortcuts, action, event),
      );
      if (direction) {
        const selection = store.getState().view.selection;
        if (selection.size === 0) return;
        event.preventDefault();
        const steps: Record<string, [number, number]> = {
          moveLeft: [-NUDGE_STEP_PX, 0],
          moveRight: [NUDGE_STEP_PX, 0],
          moveUp: [0, -NUDGE_STEP_PX],
          moveDown: [0, NUDGE_STEP_PX],
        };
        const step = steps[direction];
        if (!step) return;
        const current = store.getState().view.nudge ?? { dx: 0, dy: 0 };
        store.dispatch({
          type: "nudgeChanged",
          nudge: { dx: current.dx + step[0], dy: current.dy + step[1] },
        });
        if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
        nudgeTimerRef.current = setTimeout(commitNudge, NUDGE_COMMIT_DELAY_MS);
      }
    },
    [
      shortcuts,
      applySelection,
      closeOverlay,
      closeSurface,
      commitNudge,
      controller,
      openOverlay,
      requestDeleteNodes,
      zoomAtPoint,
      changeLink,
      store.getState,
      store.dispatch,
      viewportRef.current?.getBoundingClientRect,
      setHoverEdge,
      linkRef.current,
    ],
  );

  return handleKeyDown;
}
