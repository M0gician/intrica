import type { AgentContextUsage } from "@intrica/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import type { AccessRecord } from "../../components/AgentAccessCard";
import { tr } from "../../i18n";
import type { Activity } from "./model";
import type { UnknownCall } from "./UnknownTools";
import { useRunEvents } from "./useRunEvents";

type AgentFeed = {
  events: Activity[];
  running: boolean;
  requests: AccessRecord[];
  conversationId: string | null;
  lastEventSeq: string;
  interrupted: boolean;
  runId?: string;
  runState?: string;
  runReason?: string | null;
  configurationBlocked?: boolean;
  supersededByRunId?: string | null;
  unknownTools?: UnknownCall[];
  context?: AgentContextUsage;
  nextBefore?: number | null | undefined;
  nextAfter?: number | null | undefined;
};

export function useAgentActivity(
  nodeId: string,
  active: boolean,
  focusRequest?: { id: string; nonce: number },
) {
  const { agentRequest, activity } = useSessionConnection();
  const readPage = useCallback(
    (path: string) => activity.request(path, () => agentRequest<AgentFeed>(path)),
    [activity, agentRequest],
  );
  const [data, setData] = useState<AgentFeed>({
    events: [],
    running: false,
    requests: [],
    conversationId: null,
    lastEventSeq: "0",
    interrupted: false,
  });
  const visible = useRef(active);
  visible.current = active;
  const [viewingHistory, setViewingHistory] = useState(false);
  const pageGeneration = useRef(0);
  const cursor = data.nextBefore;
  const loadPage = async (query = "", signal?: AbortSignal) => {
    const generation = ++pageGeneration.current;
    setViewingHistory(Boolean(query));
    try {
      const next = await readPage(
        `canvas-agents/${nodeId}?${focusRequest ? `requestId=${encodeURIComponent(focusRequest.id)}` : ""}${query}`,
      );
      if (signal?.aborted || generation !== pageGeneration.current) return;
      setData(next);
      setError("");
    } catch (error) {
      if (!signal?.aborted && generation === pageGeneration.current)
        setError((error as Error).message);
      throw error;
    }
  };
  useRunEvents({
    active: active && !viewingHistory && data.running,
    runId: data.runId,
    cursor: data.lastEventSeq,
    onEvent(event) {
      if (event.type === "input.receipt")
        activity.invalidate({ conversationId: event.payload.conversationId, agentIds: [nodeId] });
      if (event.type === "message" && event.payload.streaming)
        setData((current) => ({
          ...current,
          lastEventSeq: event.seq,
          events: [
            ...current.events.filter((item) => item.seq > 0),
            { seq: -1, agentId: nodeId, kind: "assistant", data: event.payload },
          ],
        }));
      else if (event.type === "message" || event.type === "run.finished")
        activity.invalidate({ agentIds: [nodeId] });
    },
    async recover() {
      const generation = pageGeneration.current;
      const next = await readPage(`canvas-agents/${nodeId}`);
      if (generation !== pageGeneration.current) return null;
      setData(next);
      return next.running && next.runId ? { runId: next.runId, cursor: next.lastEventSeq } : null;
    },
    onError(error) {
      setError(error instanceof Error ? error.message : tr("读取失败"));
    },
  });
  const loadEarlier = async (signal: AbortSignal) => {
    if (cursor) await loadPage(`&before=${cursor}`, signal);
  };
  const loadUntil = async (seq: number, signal: AbortSignal) => {
    await loadPage(`&around=${seq}`, signal);
  };
  const loadFullEvent = async (seq: number) => {
    const generation = pageGeneration.current;
    const event = await agentRequest<Activity>(`canvas-agents/${nodeId}/events/${seq}`);
    if (generation === pageGeneration.current)
      setData((current) => ({
        ...current,
        events: current.events.map((e) => (e.seq === seq ? event : e)),
      }));
  };
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const interrupted = data.interrupted;
  const conversationId = data.conversationId;
  useEffect(() => {
    if (!active || viewingHistory) return;
    let closed = false;
    const poll = async () => {
      try {
        const generation = pageGeneration.current;
        const next = await readPage(
          `canvas-agents/${nodeId}${focusRequest ? `?requestId=${encodeURIComponent(focusRequest.id)}` : ""}`,
        );
        if (closed || generation !== pageGeneration.current) return;
        setData(next);
        setError("");
      } catch (e) {
        if (!closed) setError(e instanceof Error ? e.message : tr("读取失败"));
      }
    };
    const unfollow = activity.follow(
      [
        { kind: "agent", id: nodeId },
        ...(conversationId ? [{ kind: "conversation" as const, id: conversationId }] : []),
      ],
      poll,
    );
    return () => {
      closed = true;
      unfollow();
    };
  }, [nodeId, active, viewingHistory, readPage, focusRequest, activity, conversationId]);
  const act = async (path: string, body: unknown) => {
    setBusy(true);
    setError("");
    try {
      await agentRequest(path, body);
      if (visible.current) await loadPage();
      if (path.endsWith("/stop"))
        setData((current) => ({ ...current, running: false, interrupted: true }));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("操作失败"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return {
    data,
    setData,
    viewingHistory,
    setViewingHistory,
    cursor,
    loadPage,
    loadEarlier,
    loadUntil,
    loadFullEvent,
    error,
    setError,
    busy,
    interrupted,
    act,
  };
}
