import { effectiveModel } from "@intrica/contracts";
import { memo, useMemo, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { BottomBar, computeActionAvailability } from "../../components/BottomBar";
import { ModelRequired } from "../../components/ModelRequired";
import { TaskBar } from "../../components/TaskBar";
import { Toast } from "../../components/Toast";
import { useOptionalModels } from "../../data/models";
import { tr } from "../../i18n";
import type { WorkspaceController } from "../../state/controller";
import { useStore, useViewValue } from "../../state/store";
import type { GraphState } from "../../state/types";
import type { AgentBoard } from "../conversations/model";
import type { CanvasCommands } from "./useCanvasCommands";
import type { CanvasSelection } from "./useCanvasSelection";

type Props = Pick<CanvasSelection, "inspectNode" | "readPdfWithAgent"> &
  Pick<
    CanvasCommands,
    "handleBottomBarAction" | "requestDeleteNodes" | "taskChips" | "handleAcceptOperation"
  > & {
    graph: GraphState;
    controller: WorkspaceController;
    agentBoard: AgentBoard | null;
    readonlyOverlay: boolean;
    closeSurface: () => void;
    announce: (text: string) => void;
  };
export const CanvasFooter = memo(function CanvasFooter({
  graph,
  controller,
  agentBoard,
  readonlyOverlay,
  closeSurface,
  announce,
  inspectNode,
  readPdfWithAgent,
  handleBottomBarAction,
  requestDeleteNodes,
  taskChips,
  handleAcceptOperation,
}: Props) {
  const store = useStore();
  const models = useOptionalModels();
  const defaultReady = effectiveModel(models?.data).ready;
  const { controlCanvasAgents } = useSessionConnection();
  const selection = useViewValue((view) => view.selection);
  const surface = useViewValue((view) => view.surface);
  const toast = useViewValue((view) => view.toast);
  const statusMessage = useViewValue((view) => view.statusMessage);
  const view = { selection, surface, toast, statusMessage };
  const availability = useMemo(
    () => computeActionAvailability(graph.nodes, view.selection),
    [graph.nodes, view.selection],
  );
  const selectedAgents = useMemo(
    () => [...view.selection].filter((id) => graph.nodes.get(id)?.kind === "agent"),
    [graph.nodes, view.selection],
  );
  const selectedAgentScope = useMemo(() => {
    const team = new Set(selectedAgents);
    let changed = true;
    while (changed) {
      changed = false;
      for (const a of agentBoard?.agents ?? [])
        if (a.managerId && team.has(a.managerId) && !team.has(a.id)) {
          team.add(a.id);
          changed = true;
        }
    }
    return team;
  }, [agentBoard, selectedAgents]);
  const [batchAgentBusy, setBatchAgentBusy] = useState(false);
  const teamReady = [...selectedAgentScope].every(
    (id) => effectiveModel(models?.data, graph.nodes.get(id)?.agent?.model).ready,
  );
  const batchAgentState =
    selectedAgents.length > 0
      ? (([...selectedAgentScope].some((id) =>
          ["working", "waiting"].includes(
            agentBoard?.agents.find((a) => a.id === id)?.status ?? "",
          ),
        )
          ? "working"
          : "idle") as "idle" | "working")
      : undefined;

  return (
    <section className="bottom-region" aria-label={tr("选中操作、生成任务与通知")}>
      {!readonlyOverlay && (
        <BottomBar
          availability={{
            ...availability,
            actions: availability.actions.map((action) =>
              action.id === "link" || defaultReady
                ? action
                : { ...action, enabled: false, disabledReason: tr("添加端点和模型") },
            ),
          }}
          moreOpen={surface?.type === "more"}
          canInspect={view.selection.size === 1}
          onAction={handleBottomBarAction}
          onReadPdf={readPdfWithAgent}
          agentRunState={batchAgentState}
          agentRunBusy={batchAgentBusy || (batchAgentState === "idle" && !teamReady)}
          onAgentRun={(action) => {
            if (batchAgentBusy || (action === "start" && !teamReady)) return;
            setBatchAgentBusy(true);
            void controlCanvasAgents(selectedAgents, action)
              .then((result) =>
                announce(
                  tr("{{v0}} {{v1}} 个 Agent", {
                    v0: action === "start" ? tr("已请求启动") : tr("已请求停止"),
                    v1: result.count,
                  }),
                ),
              )
              .catch((error) =>
                announce(error instanceof Error ? error.message : tr("批量操作失败")),
              )
              .finally(() => {
                setBatchAgentBusy(false);
              });
          }}
          onToggleMore={() => {
            if (surface?.type === "more") closeSurface();
            else store.dispatch({ type: "surfaceOpened", surface: { type: "more" } });
          }}
          onDelete={() => {
            closeSurface();
            requestDeleteNodes([...store.getState().view.selection]);
          }}
          onCopy={() => {
            closeSurface();
            void controller.copyNodes([...store.getState().view.selection]);
          }}
          onInspect={() => {
            closeSurface();
            const id = [...store.getState().view.selection][0];
            if (id) inspectNode(id);
          }}
        />
      )}
      {selectedAgents.length > 0 && !teamReady && (
        <ModelRequired
          selection={
            graph.nodes.get(
              selectedAgents.find(
                (id) => !effectiveModel(models?.data, graph.nodes.get(id)?.agent?.model).ready,
              ) ?? selectedAgents[0]!,
            )?.agent?.model
          }
        />
      )}

      <TaskBar
        chips={taskChips}
        onCancel={(id) => void controller.cancelOperation(id)}
        onAcceptAll={handleAcceptOperation}
        onReviewOne={(id) =>
          store.dispatch({ type: "panelOpened", panel: { type: "review", operationId: id } })
        }
        onDiscard={(id) => void controller.discardOperation(id)}
        onRetry={(id) => void controller.retryOperation(id)}
        onShowReason={(id) =>
          store.dispatch({
            type: "surfaceOpened",
            surface: { type: "opReason", operationId: id },
          })
        }
        onUndo={(id) => void controller.undoOperation(id)}
        onClose={(id) => store.dispatch({ type: "operationDismissed", operationId: id })}
      />

      {view.toast && (
        <Toast
          toast={view.toast}
          onAction={(kind, operationId, commandId) => {
            store.dispatch({ type: "toastDismissed" });
            if (kind === "undo") void controller.undoWorkspace(commandId);
            else if (kind === "retry" && operationId) void controller.retryOperation(operationId);
          }}
          onDismiss={() => store.dispatch({ type: "toastDismissed" })}
        />
      )}
      <div aria-live="polite" role="status" className="sr-only">
        {view.statusMessage}
      </div>
    </section>
  );
});
