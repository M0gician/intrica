import type { Node } from "@intrica/contracts";
import { useMemo, useRef } from "react";
import { useSessionConnection } from "../../api/connection";
import { NodeCard } from "../../components/NodeCard";
import type { useNodeActions } from "../../components/useNodeActions";
import { tr } from "../../i18n";
import type { ViewState } from "../../state/types";
import { colorTierOf, nodeDisplayTitle } from "../../utils/graph";
import type { AgentBoard } from "../conversations/model";
import type { CanvasLinks } from "./useCanvasLinks";
import type { CanvasScene } from "./useCanvasScene";
import type { CanvasSelection } from "./useCanvasSelection";
import type { useNodeDrag } from "./useNodeDrag";
export type CanvasCards = ReturnType<typeof useCanvasCards>;
type Input = CanvasScene &
  Pick<CanvasSelection, "inspectNode"> &
  Pick<CanvasLinks, "startLink" | "linkGesture"> &
  Pick<ReturnType<typeof useNodeDrag>, "handleHeaderPointerDown"> & {
    view: ViewState;
    agentBoard: AgentBoard | null;
    handleSelect: (id: string, additive: boolean) => void;
    handleNodeHover: ReturnType<typeof useNodeActions>["hover"];
    saveTodo: (id: string, text: string, completed?: boolean) => Promise<boolean>;
    openTeam: (id: string) => void;
    measureNode: (id: string, height: number) => void;
  };
export function useCanvasCards({
  graph,
  scene,
  crossCounts,
  baseEdgeRects,
  overlayEdgeRects,
  overlayEdgeWorldRects,
  readonlyOverlay,
  generatingNodeIds,
  view,
  agentBoard,
  inspectNode,
  startLink,
  linkGesture,
  handleHeaderPointerDown,
  handleSelect,
  handleNodeHover,
  saveTodo,
  openTeam,
  measureNode,
}: Input) {
  const { storage } = useSessionConnection();
  const agents = useMemo(
    () => new Map(agentBoard?.agents.map((agent) => [agent.id, agent])),
    [agentBoard],
  );
  const actionsRef = useRef({
    handleSelect,
    handleHeaderPointerDown,
    inspectNode,
    handleNodeHover,
    saveTodo,
    openTeam,
    measureNode,
    startLink,
  });
  actionsRef.current = {
    handleSelect,
    handleHeaderPointerDown,
    inspectNode,
    handleNodeHover,
    saveTodo,
    openTeam,
    measureNode,
    startLink,
  };
  const cardActions = useMemo(
    () => ({
      onSelect: (...args: Parameters<typeof handleSelect>) =>
        actionsRef.current.handleSelect(...args),
      onHeaderPointerDown: (...args: Parameters<typeof handleHeaderPointerDown>) =>
        actionsRef.current.handleHeaderPointerDown(...args),
      onInspect: (id: string) => actionsRef.current.inspectNode(id),
      onHoverChange: (...args: Parameters<typeof handleNodeHover>) =>
        actionsRef.current.handleNodeHover(...args),
      onSaveTodo: (...args: Parameters<typeof saveTodo>) => actionsRef.current.saveTodo(...args),
      onOpenTeam: (...args: Parameters<typeof openTeam>) => actionsRef.current.openTeam(...args),
      onMeasure: (...args: Parameters<typeof measureNode>) =>
        actionsRef.current.measureNode(...args),
      onConnect: (...args: Parameters<typeof startLink>) => actionsRef.current.startLink(...args),
    }),
    [],
  );
  const renderNodeCard = (node: Node, layer: "base" | "overlay" | "drag") => {
    const { onConnect, ...nodeActions } = cardActions;
    const rect = (
      layer === "drag"
        ? overlayEdgeWorldRects.get(node.id)
          ? overlayEdgeWorldRects
          : baseEdgeRects
        : layer === "base"
          ? baseEdgeRects
          : overlayEdgeRects
    ).get(node.id)!;
    const dropTarget = view.drag?.target;
    return (
      <NodeCard
        key={node.id}
        node={node}
        tier={colorTierOf(node, graph.latestModelBatchAt)}
        selected={view.selection.has(node.id)}
        dragging={layer === "drag"}
        zoom={view.zoom}
        left={rect.x}
        top={rect.y}
        childCount={node.childOrder.length}
        crossScopeCount={crossCounts.get(node.id) ?? 0}
        {...(node.childOrder.length > 0
          ? {
              childPreview: node.childOrder
                .slice(0, 3)
                .map((id) => graph.nodes.get(id))
                .filter((child): child is Node => Boolean(child))
                .map(nodeDisplayTitle),
            }
          : {})}
        {...(() => {
          const a = agents.get(node.id);
          if (!a) return { agentStatus: tr("待命"), agentStatusKind: "idle" as const };
          if (a.status === "working")
            return { agentStatus: tr("工作中"), agentStatusKind: "working" as const };
          if (a.status === "waiting")
            return {
              agentStatus:
                a.waitReason === "message"
                  ? tr("等待消息")
                  : a.waitReason === "approval"
                    ? tr("等待审批")
                    : a.waitReason === "unknown"
                      ? tr("结果待核实")
                      : tr("等待处理"),
              agentStatusKind: "waiting" as const,
            };
          let read = 0;
          try {
            read = Number(storage.getItem(`intrica:agent-read:${node.id}`));
          } catch {}
          if (a.messageSeq > read)
            return { agentStatus: tr("有新消息"), agentStatusKind: "new" as const };
          if (a.status === "error")
            return {
              agentStatus: tr("需要处理"),
              agentStatusKind: "error" as const,
            };
          if (a.status === "complete")
            return { agentStatus: tr("已完成"), agentStatusKind: "complete" as const };
          return { agentStatus: tr("待命"), agentStatusKind: "idle" as const };
        })()}
        generating={generatingNodeIds.has(node.id)}
        dropHighlight={dropTarget?.kind === "node" && dropTarget.nodeId === node.id}
        deleting={view.deletingNodeIds.has(node.id)}
        {...nodeActions}
        teamMembers={scene.teams.get(node.id) ?? []}
        {...(!readonlyOverlay ? { onConnect } : {})}
        connecting={linkGesture?.target === node.id}
        linkPicking={Boolean(linkGesture)}
      />
    );
  };

  return renderNodeCard;
}
