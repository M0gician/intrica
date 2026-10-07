import { newId } from "@intrica/client";
import { useCallback, useState } from "react";
import type { WorkspacePanelMode } from "../../components/WorkspacePanel";
import { tr } from "../../i18n";
import type { WorkspaceController } from "../../state/controller";
import { useStore } from "../../state/store";
import { nodeBookmark, type ResourceTarget } from "../../utils/resource-view";
export type CanvasSelection = ReturnType<typeof useCanvasSelection>;
export function useCanvasSelection(controller: WorkspaceController, closeSurface: () => void) {
  const store = useStore();
  const [sidebarWidth, setSidebarWidth] = useState(480);
  const [resourceTarget, setResourceTarget] = useState<ResourceTarget>();
  const [sidebarMode, setSidebarMode] = useState<WorkspacePanelMode>("detail");
  const [composeRequest, setComposeRequest] = useState<{ id: string; text: string }>();
  const readPdfWithAgent = useCallback(
    (nodeIds: string[]) => {
      setComposeRequest({
        id: newId(),
        text: tr(
          "请使用 read 的 node 目标 按页阅读以下 PDF，注明页码与未读范围；无文本层时检查页面图像，不要声称已执行 OCR。节点：{{ids}}",
          { ids: nodeIds.join(", ") },
        ),
      });
      setSidebarMode("agent");
      store.dispatch({ type: "surfaceClosed" });
      store.dispatch({ type: "panelOpened", panel: { type: "inspector", nodeId: null } });
    },
    [store.dispatch],
  );

  const applySelection = useCallback(
    (selection: ReadonlySet<string>) => {
      store.dispatch({ type: "selectionChanged", selection });
      const panel = store.getState().view.panel;
      if (panel?.type === "inspector" && sidebarMode === "detail") {
        const nodeId = selection.size === 1 ? [...selection][0]! : null;
        store.dispatch({ type: "panelOpened", panel: { type: "inspector", nodeId } });
      }
    },
    [sidebarMode, store],
  );
  const inspectNode = useCallback(
    (nodeId: string) => {
      const node = store.getState().graph.nodes.get(nodeId);
      const bookmark = node ? nodeBookmark(node) : null;
      if (node?.kind === "text" && node.resource?.type === "directory") {
        setResourceTarget({
          type: "directory",
          path: node.resource.path,
          nodeId,
          nonce: newId(),
        });
        setSidebarMode("files");
      } else if (bookmark) {
        void controller.refreshBookmarkTitle(nodeId);
        setResourceTarget({ type: "web", url: bookmark.url, nodeId, nonce: newId() });
        setSidebarMode("browser");
      } else setSidebarMode("detail");
      store.dispatch({ type: "selectionChanged", selection: new Set([nodeId]) });
      store.dispatch({ type: "panelOpened", panel: { type: "inspector", nodeId } });
      closeSurface();
    },
    [closeSurface, controller, store.dispatch, store.getState],
  );

  return {
    sidebarWidth,
    setSidebarWidth,
    resourceTarget,
    setResourceTarget,
    sidebarMode,
    setSidebarMode,
    composeRequest,
    readPdfWithAgent,
    applySelection,
    inspectNode,
  };
}
