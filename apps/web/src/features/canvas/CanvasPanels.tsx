import { memo, useCallback, useMemo } from "react";
import { ReviewPanel } from "../../components/ReviewPanel";
import { WorkspacePanel } from "../../components/WorkspacePanel";
import type { WorkspaceController } from "../../state/controller";
import { useStore, useViewValue } from "../../state/store";
import type { GraphState } from "../../state/types";
import type { CanvasCommands } from "./useCanvasCommands";
import type { useCanvasImports } from "./useCanvasImports";
import type { CanvasSelection } from "./useCanvasSelection";

type Props = Pick<
  CanvasSelection,
  | "composeRequest"
  | "resourceTarget"
  | "sidebarMode"
  | "setSidebarMode"
  | "sidebarWidth"
  | "setSidebarWidth"
  | "inspectNode"
  | "applySelection"
> &
  Pick<CanvasCommands, "handleAcceptOperation" | "handlePreviewInside"> &
  Pick<ReturnType<typeof useCanvasImports>, "importItems"> & {
    controller: WorkspaceController;
    graph: GraphState;
    openTeam: (id: string) => void;
    previewNodeTitle: (id: string) => string;
  };
export const CanvasPanels = memo(function CanvasPanels({
  composeRequest,
  resourceTarget,
  sidebarMode,
  setSidebarMode,
  sidebarWidth,
  setSidebarWidth,
  inspectNode,
  applySelection,
  handleAcceptOperation,
  handlePreviewInside,
  importItems,
  controller,
  graph,
  openTeam,
  previewNodeTitle,
}: Props) {
  const store = useStore();
  const panel = useViewValue((view) => view.panel);
  const selection = useViewValue((view) => view.selection);
  const baseScopeId = useViewValue((view) => view.baseScopeId);
  const view = { panel, selection, baseScopeId };
  const sidebarSelection = useMemo(() => [...selection], [selection]);
  const inspectorNode =
    panel?.type === "inspector" && panel.nodeId ? graph.nodes.get(panel.nodeId) : undefined;
  const reviewOperation =
    panel?.type === "review" ? graph.operations.get(panel.operationId) : undefined;
  const handleSaveNode = useCallback(
    (
      nodeId: string,
      patch: {
        title?: string;
        text?: string;
        alt?: string;
        summary?: string;
        agent?: import("@intrica/contracts").AgentConfig;
      },
      expectedRevision?: number,
    ) => {
      return controller.saveNodeContent(nodeId, patch, expectedRevision);
    },
    [controller],
  );

  const closePanel = useCallback(() => store.dispatch({ type: "panelClosed" }), [store]);
  const selectPanelNode = useCallback(
    (id: string) => applySelection(new Set([id])),
    [applySelection],
  );
  const deletePanelEdge = useCallback(
    (edge: import("@intrica/contracts").Edge) => {
      void controller.deleteLink(edge);
    },
    [controller],
  );
  return (
    <>
      <WorkspacePanel
        composeRequest={composeRequest}
        selection={sidebarSelection}
        resourceTarget={resourceTarget}
        onActivateNode={inspectNode}
        focusRequest={view.panel?.type === "inspector" ? view.panel.focusRequest : undefined}
        mode={sidebarMode}
        onModeChange={setSidebarMode}
        open={view.panel?.type === "inspector"}
        node={inspectorNode}
        canvasId={view.baseScopeId}
        nodes={graph.nodes}
        edges={graph.edges}
        operations={graph.operations}
        width={sidebarWidth}
        onWidthChange={setSidebarWidth}
        onImport={importItems}
        onClose={closePanel}
        onSelectNode={selectPanelNode}
        onOpenOverlay={openTeam}
        onSave={handleSaveNode}
        onDeleteEdge={deletePanelEdge}
      />
      {reviewOperation && (
        <ReviewPanel
          onDecideCandidate={(opId, candidateId, action) =>
            controller.decideCandidate(opId, candidateId, action)
          }
          operation={reviewOperation}
          candidates={[...graph.candidateNodes.values()].filter(
            (candidate) => candidate.operationId === reviewOperation.id,
          )}
          candidateContainer={
            reviewOperation.resultContainerId
              ? (graph.candidateContainers.get(reviewOperation.resultContainerId) ?? null)
              : null
          }
          inputTitles={reviewOperation.selection.map(previewNodeTitle)}
          memberTitles={reviewOperation.selection.map(previewNodeTitle)}
          onClose={() => store.dispatch({ type: "panelClosed" })}
          onAcceptAll={handleAcceptOperation}
          onDiscard={(id) => void controller.discardOperation(id)}
          onRetry={(id) => void controller.retryOperation(id)}
          onUndo={(id) => void controller.undoOperation(id)}
          onPreviewInside={handlePreviewInside}
        />
      )}
    </>
  );
});
