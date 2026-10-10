import type {
  AgentContextUsage,
  MessageRequestView,
  ResourceResponseStatus,
} from "@intrica/contracts";
import { type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import type { AccessRecord } from "../../components/AgentAccessCard";
import { tr } from "../../i18n";
import { FullRecords, recordVersion } from "./full-records";
import type { Activity } from "./model";
import type { UnknownCall } from "./UnknownTools";
import { useRunEvents } from "./useRunEvents";

type AgentFeed = {
  events: Activity[];
  messageRequests?: MessageRequestView[];
  running: boolean;
  requests: AccessRecord[];
  conversationId: string | null;
  lastEventSeq: string;
  interrupted: boolean;
  runId?: string;
  runState?: string;
  runReason?: string | null;
  configurationBlocked?: boolean;
  resourceResponse?: ResourceResponseStatus | null;
  supersededByRunId?: string | null;
  unknownTools?: UnknownCall[];
  context?: AgentContextUsage;
  nextBefore?: number | null | undefined;
  nextAfter?: number | null | undefined;
};

const EMPTY_FEED: AgentFeed = {
  events: [],
  running: false,
  requests: [],
  conversationId: null,
  lastEventSeq: "0",
  interrupted: false,
};

export function useAgentActivity(
  nodeId: string,
  active: boolean,
  focusRequest?: { id: string; nonce: number },
) {
  const { agentRequest, activity, bindingId } = useSessionConnection();
  const records = useMemo(() => new FullRecords(`${bindingId}:${nodeId}`), [nodeId, bindingId]);
  const scope = useRef(records);
  scope.current = records;
  const readPage = useCallback(
    async (path: string) => {
      let next: AgentFeed, revision: number;
      do {
        revision = records.revision;
        next = await activity.request(path, () => agentRequest<AgentFeed>(path));
        // A full read can observe a newer record than an in-flight summary.
        // Repeat that summary read before accepting it, including history pages.
      } while (scope.current === records && revision !== records.revision);
      return next;
    },
    [activity, agentRequest, records],
  );
  const [stored, setStored] = useState({ scope: records, value: EMPTY_FEED });
  const data = stored.scope === records ? stored.value : EMPTY_FEED;
  const dataRef = useRef(data);
  dataRef.current = data;
  const setData = useCallback(
    (update: SetStateAction<AgentFeed>) => {
      if (scope.current !== records) return;
      setStored((current) => ({
        scope: records,
        value:
          typeof update === "function"
            ? update(current.scope === records ? current.value : EMPTY_FEED)
            : update,
      }));
    },
    [records],
  );
  const acceptPage = useCallback(
    (next: AgentFeed) => {
      setData({ ...next, events: records.merge(next.events) });
    },
    [records, setData],
  );
  const visible = useRef(active);
  visible.current = active;
  const [history, setHistory] = useState({ scope: records, value: false });
  const viewingHistory = history.scope === records && history.value;
  const setViewingHistory = (value: boolean) => setHistory({ scope: records, value });
  const pageGeneration = useRef(0);
  const cursor = data.nextBefore;
  const loadPage = async (query = "", signal?: AbortSignal) => {
    const generation = ++pageGeneration.current;
    setViewingHistory(Boolean(query));
    try {
      const next = await readPage(
        `canvas-agents/${nodeId}?${focusRequest ? `requestId=${encodeURIComponent(focusRequest.id)}` : ""}${query}`,
      );
      if (signal?.aborted || generation !== pageGeneration.current || scope.current !== records)
        return;
      acceptPage(next);
      setError("");
    } catch (error) {
      if (!signal?.aborted && generation === pageGeneration.current && scope.current === records)
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
      if (generation !== pageGeneration.current || scope.current !== records) return null;
      acceptPage(next);
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
  const loadFullEvent = useCallback(
    async (seq: number) => {
      const preview = dataRef.current.events.find((event) => event.seq === seq);
      if (!preview?.data.truncated) return;
      const event = await records.load(preview, () =>
        agentRequest<Activity>(`canvas-agents/${nodeId}/events/${seq}`),
      );
      if (scope.current === records)
        setData((current) => ({
          ...current,
          events: current.events.map((e) => {
            if (e.seq !== seq || e.conversationId !== event.conversationId) return e;
            if (recordVersion(e) === recordVersion(event)) return records.merge([e])[0]!;
            return recordVersion(e) === recordVersion(preview) ? event : e;
          }),
        }));
    },
    [agentRequest, nodeId, records, setData],
  );
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
        if (closed || generation !== pageGeneration.current || scope.current !== records) return;
        acceptPage(next);
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
  }, [
    nodeId,
    active,
    viewingHistory,
    readPage,
    focusRequest,
    activity,
    conversationId,
    records,
    acceptPage,
  ]);
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
