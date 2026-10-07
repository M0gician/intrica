import type { StreamHandle } from "@intrica/client";
import type { GraphDelta, GraphMutationResponse } from "@intrica/contracts";
import type { ApiClient } from "../../api/client";
import { tr } from "../../i18n";
import type { Store } from "../../state/store";
import type { ActivityService } from "../activity";
import type { Feedback } from "./feedback";

export function createGraphSession(
  store: Store,
  api: ApiClient,
  activity: ActivityService,
  feedback: Feedback,
) {
  const commits = new Map<number, GraphDelta>();
  const history = new Map<string, Array<{ id: string; revision: number }>>();
  const loading = new Map<string, Promise<void>>();
  const operations = new Map<string, { again: boolean }>();
  let stream: StreamHandle | null = null;
  let generation = 0;
  let closed = false;
  let snapshotPending = false;
  let inspectedContentKey: string | null = null;
  let unsubscribe: (() => void) | undefined;

  const settlePreview = (delta: GraphDelta) => {
    if (!delta.command) return;
    store.dispatch({ type: "movePreviewRemoved", requestId: delta.command.requestId });
    store.dispatch({ type: "linkPreviewRemoved", edgeId: delta.command.requestId });
  };
  const drain = () => {
    if (snapshotPending) return;
    const state = store.getState();
    for (const [revision, delta] of commits) {
      if (delta.canvasId !== state.view.baseScopeId) commits.delete(revision);
      else if (revision <= state.graph.graphRevision) {
        commits.delete(revision);
        settlePreview(delta);
      }
    }
    for (;;) {
      const next = commits.get(store.getState().graph.graphRevision + 1);
      if (!next) break;
      const before = store.getState().graph;
      commits.delete(next.graphRevision);
      store.dispatch({ type: "graphDelta", delta: next });
      const agents = next.nodes.filter((node) => node.kind === "agent").map((node) => node.id);
      const deletedAgent = next.deletedNodeIds.some((id) => before.nodes.get(id)?.kind === "agent");
      if (agents.length || deletedAgent || next.kind === "access.apply")
        activity.invalidate({ canvasId: next.canvasId, agentIds: agents, approvals: true });
    }
  };
  const receive = (delta: GraphDelta) => {
    if (closed || delta.canvasId !== store.getState().view.baseScopeId) return;
    commits.set(delta.graphRevision, delta);
    drain();
  };
  const remember = (canvasId: string, commandId: string, revision: number) => {
    const entries = history.get(canvasId) ?? [];
    if (!entries.some((entry) => entry.id === commandId))
      history.set(
        canvasId,
        [...entries, { id: commandId, revision }]
          .sort((a, b) => a.revision - b.revision)
          .slice(-100),
      );
  };
  const record = <T extends GraphMutationResponse>(response: T): T => {
    remember(response.delta.canvasId, response.graphOpId, response.graphRevision);
    receive(response.delta);
    return response;
  };
  const loadNode = (nodeId: string): Promise<void> => {
    const node = store.getState().graph.nodes.get(nodeId);
    if (node?.contentLoaded !== false || node.parentId === null) return Promise.resolve();
    const pending = loading.get(nodeId);
    if (pending) return pending;
    const requestedGeneration = generation;
    let received = false;
    const task = api
      .getNode(nodeId)
      .then(({ node }) => {
        received = true;
        if (
          !closed &&
          requestedGeneration === generation &&
          store.getState().graph.nodes.has(nodeId)
        )
          store.dispatch({
            type: "nodeContentLoaded",
            node,
          });
      })
      .catch((error) => {
        if (!closed && requestedGeneration === generation)
          feedback.reportError(tr("读取内容失败"), error);
      })
      .finally(() => {
        if (loading.get(nodeId) === task) loading.delete(nodeId);
        const current = store.getState().graph.nodes.get(nodeId);
        if (
          received &&
          !closed &&
          requestedGeneration === generation &&
          current?.contentLoaded === false &&
          current.revision > node.revision
        )
          void loadNode(nodeId);
      });
    loading.set(nodeId, task);
    return task;
  };
  const refreshOperation = async (id: string) => {
    const prior = operations.get(id);
    if (prior) {
      prior.again = true;
      return;
    }
    const pending = { again: false };
    operations.set(id, pending);
    const requestedGeneration = generation;
    try {
      do {
        pending.again = false;
        const response = await api.getOperation(id);
        if (closed || requestedGeneration !== generation) return;
        store.dispatch({ type: "proposalLoaded", ...response });
      } while (pending.again);
    } catch (error) {
      if (!closed && requestedGeneration === generation)
        feedback.reportError(tr("读取内容失败"), error);
    } finally {
      if (operations.get(id) === pending) operations.delete(id);
    }
  };
  const syncStreams = (cursor: string) => {
    if (closed || stream) return;
    const canvasId = store.getState().view.baseScopeId;
    if (!canvasId) return;
    const subscribedGeneration = generation;
    stream = api.transport.subscribe(
      `/api/v2/canvases/${encodeURIComponent(canvasId)}/events`,
      cursor,
      {
        onEvent(event) {
          if (closed || subscribedGeneration !== generation) return;
          const payload = event.payload;
          if (event.type === "graph.changed") receive(payload);
          if (event.type === "graph.reset" || event.type === "canvas.deleted") {
            void refreshSnapshot();
            return;
          }
          if (
            event.type === "proposal.changed" ||
            (event.type === "run.changed" && payload.kind === "generation")
          )
            void refreshOperation(payload.runId ?? payload.id);
          if (event.type === "conversation.changed" || event.type === "approval.changed")
            activity.invalidate({
              canvasId,
              agentIds: [
                ...(payload.agentId ? [payload.agentId] : []),
                ...(payload.agentIds ?? []),
                ...(payload.recipients ?? []),
              ],
              ...(payload.conversationId ? { conversationId: payload.conversationId } : {}),
              approvals: event.type === "approval.changed",
            });
          if (event.type === "run.changed" && payload.kind === "conversation")
            activity.invalidate({ canvasId, conversationId: payload.subjectId });
        },
        onReset() {
          if (closed || subscribedGeneration !== generation) return;
          stream = null;
          void refreshSnapshot();
        },
        onError(error) {
          if (closed || subscribedGeneration !== generation) return;
          stream = null;
          feedback.reportError(tr("实时连接已中断"), error);
        },
      },
    );
  };
  const refreshSnapshot = async () => {
    const requestedGeneration = ++generation;
    stream?.close();
    stream = null;
    snapshotPending = true;
    loading.clear();
    operations.clear();
    try {
      const canvasId = store.getState().view.baseScopeId;
      const snapshot = await api.getSnapshot(canvasId || undefined);
      if (closed || requestedGeneration !== generation) return;
      store.dispatch({ type: "snapshotLoaded", snapshot });
      syncStreams(snapshot.canvasSeq);
      activity.invalidate({ canvasId: store.getState().view.baseScopeId, approvals: true });
    } catch (error) {
      if (!closed && requestedGeneration === generation)
        feedback.reportError(tr("加载工作区失败"), error);
    } finally {
      if (!closed && requestedGeneration === generation) {
        snapshotPending = false;
        drain();
      }
    }
  };
  const focus = () => {
    if (!stream) void refreshSnapshot();
  };
  return {
    record,
    loadNode,
    refreshSnapshot,
    refreshOperation,
    remember,
    latestCommand: () => history.get(store.getState().view.baseScopeId)?.at(-1)?.id,
    forget(commandId: string) {
      for (const [canvasId, ids] of history)
        history.set(
          canvasId,
          ids.filter((entry) => entry.id !== commandId),
        );
    },
    async init() {
      closed = false;
      unsubscribe = store.subscribe(() => {
        const { graph, view } = store.getState();
        const id = view.panel?.type === "inspector" ? view.panel.nodeId : null;
        const node = id ? graph.nodes.get(id) : undefined;
        const key =
          node && !node.contentLoaded ? `${generation}:${node.id}:${node.revision}` : null;
        if (key === inspectedContentKey) return;
        inspectedContentKey = key;
        if (key && node) void loadNode(node.id);
      });
      window.addEventListener("focus", focus);
      await refreshSnapshot();
    },
    dispose() {
      closed = true;
      generation++;
      stream?.close();
      stream = null;
      unsubscribe?.();
      window.removeEventListener("focus", focus);
    },
  };
}
export type GraphSession = ReturnType<typeof createGraphSession>;
