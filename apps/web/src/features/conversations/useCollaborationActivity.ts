import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import type { AgentBoard } from "./model";
import { type NavigationSource, navigationQuery } from "./navigation/source";

export function useCollaborationActivity(
  source: Extract<NavigationSource, { kind: "canvas" }>,
  active: boolean,
) {
  const { transport, activity } = useSessionConnection();
  const base = `/api/v2/canvas-activity?${navigationQuery(source)}`;
  const current = useRef(base);
  current.current = base;
  const generation = useRef(0);
  const [snapshot, setSnapshot] = useState<{ scope: string; board: AgentBoard }>();
  const [page, setPage] = useState({ scope: base, history: false });
  const [error, setError] = useState("");
  const viewingHistory = page.scope === base && page.history;
  const load = useCallback(
    async (query = "", signal?: AbortSignal) => {
      const request = ++generation.current;
      setPage({ scope: base, history: Boolean(query) });
      try {
        const path = `${base}${query}`;
        const next = await activity.request(path, () =>
          transport.request<AgentBoard>(path, signal ? { signal } : {}),
        );
        if (signal?.aborted || request !== generation.current || current.current !== base) return;
        setSnapshot({ scope: base, board: next });
        setError("");
      } catch (error) {
        if (!signal?.aborted && request === generation.current && current.current === base)
          setError((error as Error).message);
        throw error;
      }
    },
    [base, activity, transport],
  );
  useEffect(() => {
    if (!active || viewingHistory) return;
    const abort = new AbortController();
    const stop = activity.follow({ kind: "canvas", id: source.id }, async () => {
      await load("", abort.signal).catch(() => {});
    });
    return () => {
      stop();
      abort.abort();
    };
  }, [active, source.id, viewingHistory, activity, load]);
  return {
    board: snapshot?.scope === base ? snapshot.board : null,
    viewingHistory,
    load,
    scope: base,
    error,
  };
}
