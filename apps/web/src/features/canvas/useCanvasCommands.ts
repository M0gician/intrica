import type { Operation, Rect } from "@intrica/contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ActionId } from "../../components/BottomBar";
import { useModelReady } from "../../components/ModelRequired";
import type { TaskChipData } from "../../components/TaskBar";
import { tr } from "../../i18n";
import type { WorkspaceController } from "../../state/controller";
import { useStore } from "../../state/store";
import type { OperationIntent, ViewState } from "../../state/types";
import { unionRects } from "../../utils/geometry";
import { ancestorPath, collectSubtreeIds, commonScopeId } from "../../utils/graph";
import { OPERATION_LABELS } from "../../utils/labels";
import type { CanvasCoordinates } from "./useCanvasCoordinates";
import type { CanvasLinks } from "./useCanvasLinks";
import type { CanvasOverlay } from "./useCanvasOverlay";
import type { CanvasScene } from "./useCanvasScene";
export type CanvasCommands = ReturnType<typeof useCanvasCommands>;
type Input = Pick<CanvasScene, "graph"> &
  Pick<CanvasCoordinates, "ensureWorldBoundsVisible"> &
  Pick<CanvasOverlay, "openOverlay"> &
  Pick<CanvasLinks, "changeLink"> & {
    controller: WorkspaceController;
    view: ViewState;
    announce: (text: string) => void;
    closeSurface: () => void;
  };
export function useCanvasCommands({
  graph,
  view,
  controller,
  announce,
  closeSurface,
  ensureWorldBoundsVisible,
  openOverlay,
  changeLink,
}: Input) {
  const store = useStore();
  const modelReady = useModelReady();
  const prevOpStatusesRef = useRef<Map<string, Operation["status"]>>(new Map());
  const requestDeleteNodes = useCallback(
    (nodeIds: string[]) => {
      const state = store.getState();
      const subtreeIds = collectSubtreeIds(state.graph.nodes, nodeIds);
      const descendants = subtreeIds.length - nodeIds.length;
      // 仅多选或含子项时弹确认（规范 §9）
      if (nodeIds.length > 1 || descendants > 0) {
        store.dispatch({ type: "surfaceOpened", surface: { type: "deleteConfirm", nodeIds } });
      } else {
        void controller.deleteNodes(nodeIds);
      }
    },
    [controller, store.getState, store.dispatch],
  );
  const handleBottomBarAction = useCallback(
    (id: ActionId) => {
      const state = store.getState();
      const selection = [...state.view.selection];
      if (id === "link") {
        if (state.view.selection.size !== 2) {
          closeSurface();
          changeLink({ sources: [...state.view.selection], point: { x: 0, y: 0 }, target: null });
          return;
        }
        const from = selection[0] ? state.graph.nodes.get(selection[0]) : undefined;
        const to = selection[1] ? state.graph.nodes.get(selection[1]) : undefined;
        if (!from || !to) return;
        store.dispatch({
          type: "surfaceOpened",
          surface: { type: "linkConfirm", fromId: from.id, toId: to.id },
        });
        return;
      }
      const scopeId = commonScopeId(state.graph.nodes, state.view.selection);
      if (!scopeId) return;
      store.dispatch({
        type: "surfaceOpened",
        surface: { type: "confirm", intent: { type: id, scopeId, selection } },
      });
    },
    [closeSurface, changeLink, store.dispatch, store.getState],
  );
  const attemptCreateLink = useCallback(
    (fromId: string, toId: string) => {
      const state = store.getState();
      const from = state.graph.nodes.get(fromId);
      const to = state.graph.nodes.get(toId);
      if (!from || !to) return;
      if (fromId === toId) {
        announce(tr("不能连接节点自身"));
        return;
      }
      if (from.parentId !== to.parentId) {
        announce(tr("只能在同一层级内创建连接"));
        return;
      }
      const duplicate = [...state.graph.edges.values()].some(
        (edge) =>
          edge.type === "user_link" &&
          ((edge.from === fromId && edge.to === toId) ||
            (edge.from === toId && edge.to === fromId)),
      );
      if (duplicate) {
        announce(tr("两个节点之间已存在连接"));
        return;
      }
      void controller.createLink(fromId, toId);
    },
    [announce, controller, store.getState],
  );
  const startGeneration = useCallback(
    (intent: OperationIntent) => {
      if (!modelReady) {
        announce(tr("添加端点和模型"));
        return;
      }
      closeSurface();
      void controller.createOperation({
        type: intent.type,
        scopeId: intent.scopeId,
        selection: intent.selection,
        includeDescendants: [],
        includeConnected: false,
        instruction: "",
      });
    },
    [closeSurface, controller, modelReady, announce],
  );
  const handleAcceptOperation = useCallback(
    (operationId: string) => {
      void controller.acceptOperation(operationId).then(() => {
        const state = store.getState().graph;
        const operation = state.operations.get(operationId);
        if (!operation) return;
        const rects: Rect[] = [];
        for (const id of operation.selection) {
          const node = state.nodes.get(id);
          if (node && node.parentId === store.getState().view.baseScopeId) {
            rects.push(node.position);
          }
        }
        for (const id of operation.outputIds) {
          const node = state.nodes.get(id);
          if (node && node.parentId === store.getState().view.baseScopeId) {
            rects.push(node.position);
          }
        }
        if (operation.resultContainerId) {
          const container = state.nodes.get(operation.resultContainerId);
          if (container && container.parentId === store.getState().view.baseScopeId) {
            rects.push(container.position);
          }
        }
        ensureWorldBoundsVisible(unionRects(rects));
      });
    },
    [controller, ensureWorldBoundsVisible, store.getState],
  );
  const handlePreviewInside = useCallback(
    (operationId: string) => {
      const operation = store.getState().graph.operations.get(operationId);
      if (!operation) return;
      if (operation.placementMode === "inside_selected") {
        const inputId = operation.selection[0];
        if (inputId) openOverlay(inputId, { readonly: true, operationId });
      } else if (operation.resultContainerId) {
        openOverlay(operation.resultContainerId, { readonly: true, operationId });
      }
    },
    [openOverlay, store.getState],
  );

  useEffect(() => {
    const previous = prevOpStatusesRef.current;
    const next = new Map<string, Operation["status"]>();
    for (const operation of graph.operations.values()) {
      next.set(operation.id, operation.status);
      if (previous.get(operation.id) === operation.status) continue;
      if (operation.status === "running") {
        announce(
          tr("已开始生成（{{v0}}）", {
            v0: OPERATION_LABELS[operation.type],
          }),
        );
      } else if (operation.status === "candidate") {
        announce(
          tr("生成完成，等待确认（{{v0}}）", {
            v0: OPERATION_LABELS[operation.type],
          }),
        );
      }
    }
    prevOpStatusesRef.current = next;
  }, [announce, graph.operations]);
  const taskChips = useMemo<TaskChipData[]>(() => {
    const operations = [...graph.operations.values()].filter(
      (op) => ancestorPath(graph.nodes, op.scopeId)[0]?.id === view.baseScopeId,
    );
    const latestCommittedId =
      graph.latestModelBatchOperationId !== null &&
      operations.some(
        (operation) =>
          operation.id === graph.latestModelBatchOperationId &&
          operation.status === "committed" &&
          operation.undoToken !== undefined &&
          !operation.undone,
      )
        ? graph.latestModelBatchOperationId
        : null;
    return operations
      .filter((operation) => !view.dismissedOperationIds.has(operation.id))
      .filter(
        (operation) =>
          operation.status === "queued" ||
          operation.status === "running" ||
          operation.status === "candidate" ||
          operation.status === "failed" ||
          operation.status === "cancelled" ||
          operation.status === "discarded" ||
          operation.id === latestCommittedId,
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((operation) => ({
        operation,
        queuePosition: graph.queuePositions.get(operation.id) ?? null,
        segmentCount: 0,
        candidateCount:
          [...graph.candidateNodes.values()].filter(
            (candidate) => candidate.operationId === operation.id,
          ).length || operation.outputIds.length,
      }));
  }, [graph, view.dismissedOperationIds, view.baseScopeId]);

  return {
    requestDeleteNodes,
    handleBottomBarAction,
    attemptCreateLink,
    startGeneration,
    handleAcceptOperation,
    handlePreviewInside,
    taskChips,
  };
}
