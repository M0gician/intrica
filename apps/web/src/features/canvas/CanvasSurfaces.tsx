import type { Edge, Rect } from "@intrica/contracts";
import { useMemo } from "react";
import { useSessionConnection } from "../../api/connection";
import { ConfirmStrip } from "../../components/ConfirmStrip";
import { ConflictDialog } from "../../components/ConflictDialog";
import { ContextPreviewDialog } from "../../components/ContextPreviewDialog";
import { IconClose } from "../../components/icons";
import type { useNodeActions } from "../../components/useNodeActions";
import { tr } from "../../i18n";
import type { WorkspaceController } from "../../state/controller";
import { useStore } from "../../state/store";
import type { ViewState } from "../../state/types";
import { Button } from "../../ui/button";
import { unionRects } from "../../utils/geometry";
import { collectSubtreeIds } from "../../utils/graph";
import { OPERATION_LABELS } from "../../utils/labels";
import { EdgeDeleteButton, NodeActionsRow } from "./CanvasChrome";
import { cancelPointerSession } from "./pointer-session";
import type { CanvasCommands } from "./useCanvasCommands";
import type { CanvasCoordinates } from "./useCanvasCoordinates";
import type { CanvasLinks } from "./useCanvasLinks";
import type { CanvasOverlay } from "./useCanvasOverlay";
import type { CanvasScene } from "./useCanvasScene";
import type { CanvasSelection } from "./useCanvasSelection";

type Props = Pick<
  CanvasScene,
  "baseEdgeRects" | "overlayEdgeWorldRects" | "readonlyOverlay" | "graph"
> &
  Pick<CanvasCoordinates, "toScreenRect"> &
  Pick<CanvasOverlay, "openOverlay"> &
  Pick<CanvasSelection, "inspectNode" | "sidebarWidth" | "readPdfWithAgent"> &
  Pick<
    CanvasLinks,
    "linkGesture" | "hoverEdge" | "setHoverEdge" | "onEdgeHover" | "clearEdgeTimer" | "changeLink"
  > &
  Pick<CanvasCommands, "attemptCreateLink" | "startGeneration" | "requestDeleteNodes"> & {
    controller: WorkspaceController;
    view: ViewState;
    closeSurface: () => void;
    previewNodeTitle: (id: string) => string;
    handleNodeHover: ReturnType<typeof useNodeActions>["hover"];
    nodeActionsLeaving: boolean;
  };
export function CanvasSurfaces({
  graph,
  view,
  baseEdgeRects,
  overlayEdgeWorldRects,
  readonlyOverlay,
  toScreenRect,
  openOverlay,
  inspectNode,
  sidebarWidth,
  readPdfWithAgent,
  linkGesture,
  hoverEdge,
  setHoverEdge,
  onEdgeHover,
  clearEdgeTimer,
  changeLink,
  attemptCreateLink,
  startGeneration,
  requestDeleteNodes,
  controller,
  closeSurface,
  previewNodeTitle,
  handleNodeHover,
  nodeActionsLeaving,
}: Props) {
  const store = useStore();
  const { api } = useSessionConnection();
  const surface = view.surface;
  const nodeActionsNode =
    surface?.type === "nodeActions" ? graph.nodes.get(surface.nodeId) : undefined;
  const nodeActionsWorldRect = nodeActionsNode
    ? (baseEdgeRects.get(nodeActionsNode.id) ?? overlayEdgeWorldRects.get(nodeActionsNode.id))
    : null;
  const nodeActionsRect = nodeActionsWorldRect ? toScreenRect(nodeActionsWorldRect) : null;
  const selectionBoundsWorld = useMemo(() => {
    if (surface?.type !== "contextPreview") return null;
    const rects: Rect[] = [];
    for (const id of view.selection) {
      const rect = baseEdgeRects.get(id) ?? overlayEdgeWorldRects.get(id);
      if (rect) rects.push(rect);
    }
    return unionRects(rects);
  }, [surface, view.selection, baseEdgeRects, overlayEdgeWorldRects]);
  const selectionBoundsScreen = selectionBoundsWorld ? toScreenRect(selectionBoundsWorld) : null;
  const deleteImpact = useMemo(() => {
    if (surface?.type !== "deleteConfirm") return null;
    const subtreeIds = collectSubtreeIds(graph.nodes, surface.nodeIds);
    return {
      nodeIds: surface.nodeIds,
      total: subtreeIds.length,
      descendants: subtreeIds.length - surface.nodeIds.length,
    };
  }, [graph.nodes, surface]);

  return (
    <>
      {!readonlyOverlay &&
        nodeActionsNode &&
        nodeActionsRect &&
        !view.drag?.active &&
        !linkGesture && (
          <NodeActionsRow
            anchorRect={nodeActionsRect}
            leaving={nodeActionsLeaving}
            onHoverChange={(inside) => handleNodeHover(nodeActionsNode.id, inside)}
            rightInset={view.panel?.type === "inspector" ? sidebarWidth : 0}
            canEnter={nodeActionsNode.childOrder.length > 0}
            onEnter={() => {
              closeSurface();
              openOverlay(nodeActionsNode.id);
            }}
            onInspect={() => inspectNode(nodeActionsNode.id)}
            onDelete={() => requestDeleteNodes([nodeActionsNode.id])}
          />
        )}
      {(surface?.type === "edgeActions" || hoverEdge) &&
        (() => {
          const edgeAction = surface?.type === "edgeActions" ? surface : hoverEdge!;
          return (
            <EdgeDeleteButton
              x={edgeAction.x}
              y={edgeAction.y}
              onEnter={clearEdgeTimer}
              onLeave={() => onEdgeHover({ id: edgeAction.edgeId } as Edge, null)}
              onDelete={() => {
                clearEdgeTimer();
                setHoverEdge(null);
                const edge = graph.edges.get(edgeAction.edgeId);
                closeSurface();
                if (edge) void controller.deleteLink(edge);
              }}
            />
          );
        })()}
      {linkGesture && (
        <div className="link-hint" role="status">
          {tr("连接")}
          {linkGesture.sources.length}
          {tr("个元素 \u00B7 点击目标或拖到目标")}{" "}
          <Button
            type="button"
            onClick={() => {
              cancelPointerSession();
              changeLink(null);
            }}
            className="link-cancel"
            aria-label={tr("取消连接")}
          >
            <IconClose size={14} />
          </Button>
        </div>
      )}
      {surface?.type === "linkConfirm" && (
        // biome-ignore lint/a11y/useSemanticElements: 确认分组无语义等价元素
        <div className="confirm-strip" role="group" aria-label={tr("确认连接")}>
          <p>
            {tr("连接「")}
            {previewNodeTitle(surface.fromId)}
            {tr("」与「")}
            {previewNodeTitle(surface.toId)}」？
          </p>
          <div className="confirm-strip-actions">
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                attemptCreateLink(surface.fromId, surface.toId);
                closeSurface();
              }}
            >
              {tr("确认连接")}
            </Button>
            <Button type="button" onClick={closeSurface}>
              {tr("取消")}
            </Button>
          </div>
        </div>
      )}
      {surface?.type === "confirm" && (
        <ConfirmStrip
          intent={surface.intent}
          onBack={closeSurface}
          onStart={() => startGeneration(surface.intent)}
          onOpenFullContext={() =>
            store.dispatch({
              type: "surfaceOpened",
              surface: { type: "contextPreview", intent: surface.intent },
            })
          }
        />
      )}
      {surface?.type === "contextPreview" && selectionBoundsScreen && (
        <ContextPreviewDialog
          intent={surface.intent}
          anchorRect={selectionBoundsScreen}
          nodeTitle={previewNodeTitle}
          loadPreview={(request) => api.previewOperation(request)}
          onConfirm={(request) => {
            closeSurface();
            void controller.createOperation(request);
          }}
          onClose={closeSurface}
          onReadPdf={readPdfWithAgent}
        />
      )}
      {surface?.type === "deleteConfirm" && deleteImpact && (
        <div className="confirm-strip" role="alertdialog" aria-label={tr("删除确认")}>
          <p className="confirm-strip-title">{tr("删除选中内容？")}</p>
          <p>
            {tr("将删除 {{v0}} 个节点", { v0: deleteImpact.total })}
            {deleteImpact.descendants > 0
              ? tr("（含 {{v0}} 个子项）", { v0: deleteImpact.descendants })
              : ""}
          </p>
          <div className="confirm-strip-actions">
            <Button type="button" onClick={closeSurface}>
              {tr("取消")}
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                const ids = deleteImpact.nodeIds;
                closeSurface();
                void controller.deleteNodes(ids);
              }}
            >
              {tr("删除")}
            </Button>
          </div>
        </div>
      )}
      {surface?.type === "opReason" &&
        (() => {
          const operation = graph.operations.get(surface.operationId);
          if (!operation) return null;
          return (
            // biome-ignore lint/a11y/useSemanticElements: 原因展示分组无语义等价元素
            <div className="confirm-strip" role="group" aria-label={tr("失败原因")}>
              <p className="confirm-strip-title">
                {OPERATION_LABELS[operation.type]}
                {tr("失败")}
              </p>
              <p>{operation.reason ?? tr("未知原因")}</p>
              <div className="confirm-strip-actions">
                <Button type="button" onClick={closeSurface}>
                  {tr("关闭")}
                </Button>
              </div>
            </div>
          );
        })()}
      {surface?.type === "conflict" && (
        <ConflictDialog
          dialog={surface.dialog}
          onRetry={(operationId) => void controller.retryOperation(operationId)}
          onDismiss={closeSurface}
        />
      )}
    </>
  );
}
