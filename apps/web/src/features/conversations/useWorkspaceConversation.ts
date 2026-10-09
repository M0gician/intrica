import { newId } from "@intrica/client";
import type { AgentContextUsage, ModelSelection, Node } from "@intrica/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { useConnection } from "../../app/connection-context";
import { useModelReady } from "../../components/ModelRequired";
import { tr } from "../../i18n";
import { useGraphValue, useStore, useViewValue } from "../../state/store";
import type { UnknownCall } from "./UnknownTools";
import { useRunEvents } from "./useRunEvents";
import { type ConversationSnapshot, restoreTurns, type Turn } from "./workspace-model";

const emptyNodes = new Map<string, Node>();
const emptySelection = new Set<string>();
export function useWorkspaceConversation(
  active: boolean,
  composeRequest?: { id: string; text: string },
) {
  const { transport, agentRequest, storage, api, activity } = useSessionConnection();
  const store = useStore();
  const [usage, setUsage] = useState<AgentContextUsage>();
  const [question, setQuestion] = useState("");
  const appliedCompose = useRef<string | null>(null);
  const composer = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!composeRequest || appliedCompose.current === composeRequest.id) return;
    appliedCompose.current = composeRequest.id;
    setQuestion((current) =>
      current ? `${current}\n\n${composeRequest.text}` : composeRequest.text,
    );
    composer.current?.querySelector("textarea")?.focus();
  }, [composeRequest]);
  const [model, setModel] = useState<ModelSelection | null>(null);
  const modelReady = useModelReady(model);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [transcriptGeneration, setTranscriptGeneration] = useState(0);
  const [unknown, setUnknown] = useState<UnknownCall[]>([]);
  const [resolutionError, setResolutionError] = useState("");
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const pendingStop = useRef<symbol | null>(null);
  const canvasId = useViewValue((view) => view.baseScopeId);
  const selection = useViewValue((view) => (active ? view.selection : emptySelection));
  const nodes = useGraphValue((graph) => (active ? graph.nodes : emptyNodes));
  const graph = { nodes };
  const { server } = useConnection();
  const sessionKey = `intrica:conversation:${server?.id ?? location.origin}:${canvasId}`;
  const readSession = useCallback(() => {
    try {
      const value = storage.getItem(sessionKey) || newId("conversation");
      storage.setItem(sessionKey, value);
      return value;
    } catch {
      return newId("conversation");
    }
  }, [sessionKey, storage.setItem, storage.getItem]);
  const [sessionId, setSessionId] = useState<string>(readSession);
  const [runId, setRunId] = useState<string>();
  const [waitingReason, setWaitingReason] = useState<string | undefined>();
  const runCursor = useRef("0");
  useEffect(() => {
    setSessionId(readSession());
    setTurns([]);
    setRunId(undefined);
    setUnknown([]);
    setWaitingReason(undefined);
    abort.current?.abort("session");
    abort.current = null;
    pendingStop.current = null;
    setSending(false);
    setStreaming(false);
    setBusy(false);
  }, [readSession]);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!active) abort.current?.abort("hidden");
  }, [active]);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  useEffect(() => () => abort.current?.abort("unmounted"), []);
  useEffect(() => {
    if (!active || busy) return;
    let closed = false;
    void agentRequest<AgentContextUsage>("agent/context", { sessionId: sessionId, model })
      .then((value) => {
        if (!closed) setUsage(value);
      })
      .catch(() => {});
    return () => {
      closed = true;
    };
  }, [active, model, busy, sessionId, agentRequest]);
  const showing = useRef(active);
  showing.current = active;
  const synchronize = useCallback(async () => {
    const path = `/api/v2/conversations/${encodeURIComponent(sessionId)}`;
    const value = await activity.request(path, () => transport.request<ConversationSnapshot>(path));
    if (!showing.current || sessionRef.current !== sessionId || abort.current) return null;
    setUnknown(value.unknownTools ?? []);
    setTurns(restoreTurns(value, sessionId));
    const running = Boolean(
      value.run && ["queued", "running", "waiting"].includes(value.run.state),
    );
    const paused = ["tool_contract_upgrade", "unknown"].includes(value.run?.reason ?? "");
    if (pendingStop.current && (!running || paused)) {
      pendingStop.current = null;
      setSending(false);
    }
    setBusy(running && !paused);
    setWaitingReason(paused ? value.run?.reason : undefined);
    setRunId(running || paused ? value.run!.id : undefined);
    runCursor.current = String(value.run?.last_event_seq ?? "0");
    if (value.context) setUsage(value.context);
    return running ? { runId: value.run!.id, cursor: runCursor.current } : null;
  }, [sessionId, transport, activity]);
  useEffect(() => {
    if (!active) return;
    let closed = false;
    const unfollow = activity.follow({ kind: "conversation", id: sessionId }, async () => {
      if (abort.current) return;
      try {
        await synchronize();
      } catch (error) {
        if (!closed) setResolutionError(error instanceof Error ? error.message : tr("读取失败"));
      }
    });
    return () => {
      closed = true;
      unfollow();
    };
  }, [active, sessionId, activity, synchronize]);
  useRunEvents({
    active: active && !streaming,
    runId,
    cursor: runCursor.current,
    recover: synchronize,
    onEvent(event) {
      if (event.type === "message")
        setTurns((current) =>
          current.map((turn, index) =>
            index === current.length - 1
              ? {
                  ...turn,
                  messages: {
                    ...turn.messages,
                    [event.payload.id]: {
                      text: event.payload.text ?? "",
                      thinking: event.payload.thinking ?? "",
                    },
                  },
                  timeline: turn.messages[event.payload.id]
                    ? turn.timeline
                    : [...turn.timeline, { kind: "message", id: event.payload.id }],
                }
              : turn,
          ),
        );
      else if (event.type === "run.finished")
        activity.invalidate({ canvasId, conversationId: sessionId });
    },
    onError(error) {
      setResolutionError(error instanceof Error ? error.message : tr("读取失败"));
    },
  });
  const cancelRun = async (runId: string, request: symbol) => {
    try {
      await transport.json("POST", `/api/v2/runs/${encodeURIComponent(runId)}/cancel`);
      // The run stream or snapshot confirms when cancellation has settled.
      activity.invalidate({ canvasId, conversationId: sessionId });
    } catch (error) {
      if (sessionRef.current !== sessionId || pendingStop.current !== request) return;
      pendingStop.current = null;
      setSending(false);
      setResolutionError(error instanceof Error ? error.message : tr("请求失败"));
    }
  };
  const stop = () => {
    const request = Symbol();
    pendingStop.current = request;
    setSending(true);
    setResolutionError("");
    if (runId) void cancelRun(runId, request);
  };
  const ask = async () => {
    if (!modelReady || sending || pendingStop.current || unknown.length) return;
    const prompt = question.trim() || tr("继续之前未完成的任务。");
    if (busy) {
      if (!question.trim()) return;
      setSending(true);
      try {
        await agentRequest("agent/steer", { sessionId, message: prompt });
        const id = newId();
        setTurns((turns) =>
          turns.map((turn, index) =>
            index === turns.length - 1
              ? {
                  ...turn,
                  timeline: [...turn.timeline, { kind: "user", id }],
                  messages: { ...turn.messages, [id]: { text: prompt, thinking: "" } },
                }
              : turn,
          ),
        );
        setQuestion((current) => (current.trim() === prompt ? "" : current));
      } catch (e) {
        setTurns((turns) =>
          turns.map((turn, index) =>
            index === turns.length - 1 ? { ...turn, error: (e as Error).message } : turn,
          ),
        );
      } finally {
        setSending(false);
      }
      return;
    }
    const id = newId();
    const activeSession = sessionId;
    setRunId(undefined);
    setStreaming(true);
    setQuestion("");
    setBusy(true);
    setTranscriptGeneration((value) => value + 1);
    setTurns((turns) => [
      ...turns,
      { id, question: prompt, messages: {}, tools: {}, timeline: [], state: "running" },
    ]);
    const update = (change: (turn: Turn) => Turn) =>
      setTurns((turns) => turns.map((turn) => (turn.id === id ? change(turn) : turn)));
    const controller = new AbortController();
    abort.current = controller;
    let settled = false;
    try {
      const view = store.getState().view;
      await api.agentChat(
        {
          sessionId: sessionId,
          ...(waitingReason === "tool_contract_upgrade" && runId ? { resumeRunId: runId } : {}),
          model,
          message: prompt,
          selection: [...selection],
          scopeId: view.overlaySpace?.containerId ?? canvasId,
        },
        (event) => {
          if (event.type === "context") setUsage(event.usage);
          if (event.type === "start") {
            setRunId(event.runId);
            if (pendingStop.current && event.runId)
              void cancelRun(event.runId, pendingStop.current);
          }
          if (event.type === "message")
            update((turn) => ({
              ...turn,
              timeline: turn.messages[event.id]
                ? turn.timeline
                : [...turn.timeline, { kind: "message", id: String(event.id) }],
              messages: {
                ...turn.messages,
                [event.id]: { text: event.text, thinking: event.thinking },
              },
            }));
          if (event.type === "tool")
            update((turn) => ({
              ...turn,
              timeline: turn.tools[event.id]
                ? turn.timeline
                : [...turn.timeline, { kind: "tool", id: event.id }],
              tools: {
                ...turn.tools,
                [event.id]: {
                  ...turn.tools[event.id],
                  ...event,
                  status:
                    event.status === "pending" && turn.tools[event.id]
                      ? turn.tools[event.id]!.status
                      : event.status,
                },
              },
            }));
          if (event.type === "complete") {
            settled = true;
            update((turn) => ({ ...turn, state: "complete" }));
          }
          if (event.type === "error") throw new Error(event.message);
        },
        controller.signal,
      );
      if (!settled) throw new Error(tr("连接中断，回答尚未完成"));
    } catch (error) {
      if (
        sessionRef.current !== activeSession ||
        ["hidden", "session", "unmounted"].includes(controller.signal.reason)
      )
        return;
      update((turn) => ({
        ...turn,
        state: controller.signal.aborted ? "stopped" : "error",
        error: controller.signal.aborted
          ? tr("已停止")
          : error instanceof Error
            ? error.message
            : tr("请求失败"),
      }));
      setQuestion((current) => current || prompt);
    } finally {
      if (abort.current === controller) {
        if (pendingStop.current) {
          pendingStop.current = null;
          setSending(false);
        }
        setBusy(false);
        abort.current = null;
        setStreaming(false);
      }
      activity.invalidate({ canvasId, conversationId: sessionId });
    }
  };

  return {
    usage,
    setUsage,
    question,
    setQuestion,
    model,
    setModel,
    turns,
    setTurns,
    unknown,
    resolutionError,
    setResolutionError,
    sending,
    setSending,
    busy,
    modelReady,
    selection,
    graph,
    canvasId,
    sessionKey,
    sessionId,
    setSessionId,
    waitingReason,
    stop,
    ask,
    storage,
    transport,
    activity,
    composer,
    transcriptGeneration,
  };
}
