import type { Edge } from "@intrica/contracts";
import { newIdempotencyKey } from "../../api/client";
import { tr } from "../../i18n";
import { collectSubtreeIds } from "../../utils/graph";
import type { CommandContext } from "./context";

export function createStructureCommands({ api, store, session, feedback }: CommandContext) {
  const undo = (commandId: string) => ({ label: tr("撤销"), kind: "undo" as const, commandId });
  return {
    async commitMove(
      targetParentId: string,
      moves: Array<{ nodeId: string; x: number; y: number }>,
    ): Promise<boolean> {
      const { graph, view } = store.getState();
      const requestId = newIdempotencyKey("move");
      store.dispatch({
        type: "movePreviewAdded",
        requestId,
        move: {
          canvasId: view.baseScopeId,
          targetParentId,
          moves: moves.map((move) => ({
            ...move,
            layoutVersion: graph.nodes.get(move.nodeId)!.layoutVersion,
          })),
        },
      });
      store.dispatch({ type: "displacementDropped", nodeIds: moves.map((move) => move.nodeId) });
      try {
        const response = session.record(
          await api.submitMove({
            kind: "move",
            targetParentId,
            idempotencyKey: requestId,
            moves: moves.map((move) => ({
              ...move,
              expectedLayoutVersion: graph.nodes.get(move.nodeId)!.layoutVersion,
            })),
          }),
        );
        feedback.showToast(
          tr("已移动 {{v0}} 个节点", { v0: moves.length }),
          undo(response.graphOpId),
        );
        return true;
      } catch (error) {
        store.dispatch({ type: "movePreviewRemoved", requestId });
        feedback.reportError(tr("移动失败，已恢复原位置"), error);
        return false;
      }
    },
    async deleteNodes(nodeIds: string[]): Promise<boolean> {
      const subtreeIds = collectSubtreeIds(store.getState().graph.nodes, nodeIds);
      store.dispatch({ type: "deletingStarted", nodeIds: subtreeIds });
      try {
        const response = session.record(
          await api.deleteNodes({
            kind: "delete",
            nodeIds,
            idempotencyKey: newIdempotencyKey("delete"),
          }),
        );
        feedback.showToast(
          tr("已删除 {{v0}} 个节点", { v0: subtreeIds.length }),
          undo(response.graphOpId),
        );
        return true;
      } catch (error) {
        feedback.reportError(tr("删除失败"), error);
        return false;
      } finally {
        store.dispatch({ type: "deletingCleared" });
      }
    },
    async copyNodes(nodeIds: string[]): Promise<string[]> {
      const canvasId = store.getState().view.baseScopeId;
      try {
        const response = session.record(
          await api.copyNodes({ nodeIds, idempotencyKey: newIdempotencyKey("copy") }),
        );
        if (store.getState().view.baseScopeId === canvasId)
          store.dispatch({ type: "selectionChanged", selection: new Set(response.nodeIds) });
        feedback.showToast(
          tr("已复制 {{v0}} 个节点", { v0: response.nodeIds.length }),
          undo(response.graphOpId),
        );
        return response.nodeIds;
      } catch (error) {
        feedback.reportError(tr("复制失败"), error);
        return [];
      }
    },
    async createLinks(fromIds: string[], toId: string): Promise<boolean> {
      try {
        const result = session.record(
          await api.createLinks({ fromIds, toId, idempotencyKey: newIdempotencyKey("links") }),
        );
        feedback.showToast(
          result.edges.length
            ? tr("已连接 {{v0}} 个元素", { v0: result.edges.length })
            : tr("这些连接已存在"),
          result.edges.length ? undo(result.graphOpId) : null,
        );
        return true;
      } catch (error) {
        feedback.reportError(tr("连接失败"), error);
        return false;
      }
    },
    async createLink(fromId: string, toId: string): Promise<boolean> {
      const requestId = newIdempotencyKey("link");
      const edge: Edge = {
        id: requestId,
        from: fromId,
        to: toId,
        type: "user_link",
        directed: false,
        confirmed: false,
        revision: 0,
        operationId: null,
        sourceRevision: null,
      };
      store.dispatch({ type: "linkPreviewAdded", edge });
      try {
        const response = session.record(
          await api.createLink({ fromId, toId, idempotencyKey: requestId }),
        );
        feedback.showToast(tr("已创建连接"), undo(response.graphOpId));
        return true;
      } catch (error) {
        store.dispatch({ type: "linkPreviewRemoved", edgeId: requestId });
        feedback.reportError(tr("连接失败，已撤销预览"), error);
        return false;
      }
    },
    async deleteLink(edge: Edge): Promise<boolean> {
      try {
        const response = session.record(
          await api.deleteLink(edge.id, {
            expectedRevision: edge.revision,
            idempotencyKey: newIdempotencyKey("unlink"),
          }),
        );
        feedback.showToast(tr("已删除连接"), undo(response.graphOpId));
        return true;
      } catch (error) {
        feedback.reportError(tr("删除连接失败，连接已保留"), error);
        return false;
      }
    },
  };
}
