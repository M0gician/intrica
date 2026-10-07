import { type Dispatch, memo, type RefObject, type SetStateAction, useState } from "react";
import { type BreadcrumbItem, TopBar } from "../../components/TopBar";
import { tr } from "../../i18n";
import type { WorkspaceController } from "../../state/controller";
import { useStore, useViewValue } from "../../state/store";
import type { GraphState } from "../../state/types";
import { Button } from "../../ui/button";
import { AgentInbox } from "../conversations/AgentInbox";
import type { AgentBoard } from "../conversations/model";
import type { CanvasCoordinates } from "./useCanvasCoordinates";
import type { CanvasOverlay } from "./useCanvasOverlay";
import type { CanvasSelection } from "./useCanvasSelection";

type Props = Pick<CanvasCoordinates, "zoomAtPoint" | "viewportSize" | "toWorld"> &
  Pick<CanvasOverlay, "closeOverlay"> &
  Pick<CanvasSelection, "inspectNode"> & {
    controller: WorkspaceController;
    graph: GraphState;
    viewportRef: RefObject<HTMLDivElement | null>;
    switchCanvas: (id: string) => void;
    setAgentBoard: Dispatch<SetStateAction<AgentBoard | null>>;
    breadcrumbPath: BreadcrumbItem[];
    handleFitView: () => void;
  };
export const CanvasHeader = memo(function CanvasHeader({
  controller,
  graph,
  viewportRef,
  switchCanvas,
  setAgentBoard,
  breadcrumbPath,
  handleFitView,
  zoomAtPoint,
  viewportSize,
  toWorld,
  closeOverlay,
  inspectNode,
}: Props) {
  const store = useStore();
  const [creatingCanvas, setCreatingCanvas] = useState(false);
  const panel = useViewValue((view) => view.panel);
  const baseScopeId = useViewValue((view) => view.baseScopeId);
  const zoom = useViewValue((view) => view.zoom);
  const overlay = useViewValue((view) => view.overlaySpace);
  const readonlyOverlay = overlay?.readonly === true;
  const view = { panel, baseScopeId, zoom };
  return (
    <>
      {graph.nodes.size === 0 && (
        <div className="empty-canvas-workspace">
          <img className="empty-brand-mark" src="/brand-mark.svg" alt="" aria-hidden="true" />
          <p className="empty-eyebrow">INTRICA · EVIDENCE CANVAS</p>
          <h2>{tr("从一张画布开始")}</h2>
          <p className="empty-description">
            {tr("把想法、资料和 Agent 的工作串成一条可回溯的线索。")}
          </p>
          <Button
            type="button"
            disabled={creatingCanvas}
            onClick={async () => {
              setCreatingCanvas(true);
              try {
                const id = await controller.createCanvas(tr("我的画布"));
                if (id) switchCanvas(id);
              } finally {
                setCreatingCanvas(false);
              }
            }}
          >
            {tr("新建第一张画布")}
          </Button>
          <span className="empty-hint">{tr("也可以把文件拖到这里，或按 \u2318 K 快速创建")}</span>
        </div>
      )}
      <AgentInbox
        canvasId={view.baseScopeId}
        onSelect={(id, requestId) => {
          inspectNode(id);
          store.dispatch({
            type: "panelOpened",
            panel: {
              type: "inspector",
              nodeId: id,
              focusRequest: { id: requestId, nonce: Date.now() },
            },
          });
        }}
        onActivity={setAgentBoard}
      />
      <TopBar
        canvases={[...graph.nodes.values()]
          .filter((n) => n.parentId === null)
          .map((n) => ({ id: n.id, title: n.title }))}
        onCanvasChange={switchCanvas}
        onDeleteCanvas={(id) => controller.deleteCanvas(id)}
        onRenameCanvas={(id, title, expectedTitle) =>
          controller.renameCanvas(id, title, expectedTitle)
        }
        onCreateCanvas={async (title) => {
          if (creatingCanvas) return false;
          setCreatingCanvas(true);
          try {
            const canvasId = await controller.createCanvas(
              title ??
                tr("画布 {{v0}}", {
                  v0: [...graph.nodes.values()].filter((n) => n.parentId === null).length + 1,
                }),
            );
            if (canvasId) switchCanvas(canvasId);
            return Boolean(canvasId);
          } finally {
            setCreatingCanvas(false);
          }
        }}
        path={breadcrumbPath}
        overlayReadonly={overlay?.readonly ?? false}
        hasOverlay={overlay !== null}
        zoom={view.zoom}
        onNavigateBack={closeOverlay}
        onZoomIn={() => {
          const rect = viewportRef.current?.getBoundingClientRect();
          zoomAtPoint(1.2, (rect?.width ?? 0) / 2, (rect?.height ?? 0) / 2);
        }}
        onZoomOut={() => {
          const rect = viewportRef.current?.getBoundingClientRect();
          zoomAtPoint(1 / 1.2, (rect?.width ?? 0) / 2, (rect?.height ?? 0) / 2);
        }}
        onFitView={handleFitView}
        onOpenSidebar={() => {
          if (store.getState().view.panel?.type === "inspector") {
            store.dispatch({ type: "panelClosed" });
            return;
          }
          const id = [...store.getState().view.selection][0];
          const panelNodeId = id && store.getState().graph.nodes.has(id) ? id : null;
          store.dispatch({
            type: "panelOpened",
            panel: { type: "inspector", nodeId: panelNodeId },
          });
        }}
        onOpenCreate={() => {
          if (readonlyOverlay) return;
          const size = viewportSize();
          const center = toWorld(size.width / 2, size.height / 2);
          store.dispatch({
            type: "surfaceOpened",
            surface: { type: "create", position: center },
          });
        }}
      />
    </>
  );
});
