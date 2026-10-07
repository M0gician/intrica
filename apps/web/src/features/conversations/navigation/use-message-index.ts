import type {
  CanvasNavigationIndex,
  ConversationNavigationIndex,
  ConversationPreview,
} from "@intrica/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionConnection } from "../../../api/connection";
import { type MessageKey, type NavigationSource, navigationQuery, navigationUrl } from "./source";

export function useMessageIndex(source: NavigationSource) {
  const { transport, activity } = useSessionConnection();
  const [index, setIndex] = useState({ items: [] as MessageKey[], revision: 0 });
  const [error, setError] = useState("");
  const current = useRef(index);
  const previews = useRef(
    new Map<MessageKey, { promise: Promise<ConversationPreview>; data?: ConversationPreview }>(),
  );
  const requests = useRef(new Set<AbortController>());
  const base = navigationUrl(source),
    query = navigationQuery(source);
  const kind = source.kind,
    id = source.id,
    agentId = source.kind === "conversation" ? source.agentId : undefined;
  useEffect(() => {
    const abort = new AbortController();
    const stop = activity.follow(
      [{ kind, id }, ...(agentId ? [{ kind: "agent" as const, id: agentId }] : [])],
      async () => {
        try {
          // Canvas messages come from independent conversations; new rows can sort before the cursor.
          let after: MessageKey | null | undefined =
            kind === "canvas" ? undefined : current.current.items.at(-1);
          const added: MessageKey[] = [];
          let revision = current.current.revision;
          do {
            const page: ConversationNavigationIndex | CanvasNavigationIndex =
              await transport.request(
                `${base}?${query}${after === undefined ? "" : `&after=${encodeURIComponent(after)}`}`,
                {
                  signal: abort.signal,
                },
              );
            added.push(...page.items);
            after = page.nextAfter;
            revision = page.revision;
          } while (after !== null);
          if (abort.signal.aborted) return;
          if (revision !== current.current.revision) {
            if (kind === "canvas") previews.current.clear();
            else previews.current.delete(current.current.items.at(-1)!);
          }
          current.current = {
            items:
              kind === "canvas"
                ? added.join() === current.current.items.join()
                  ? current.current.items
                  : added
                : added.length
                  ? [...current.current.items, ...added]
                  : current.current.items,
            revision,
          };
          setIndex(current.current);
          setError("");
        } catch (error) {
          if (!abort.signal.aborted) setError((error as Error).message);
        }
      },
    );
    return () => {
      stop();
      abort.abort();
      for (const request of requests.current) request.abort();
    };
  }, [activity, transport, base, query, kind, id, agentId]);
  const preview = useCallback(
    (seq: MessageKey) => {
      const cached = previews.current.get(seq);
      if (cached) return cached.promise;
      const abort = new AbortController();
      requests.current.add(abort);
      const result = transport
        .request<ConversationPreview>(`${base}/${encodeURIComponent(seq)}?${query}`, {
          signal: abort.signal,
        })
        .then((data) => {
          const entry = previews.current.get(seq);
          if (entry?.promise === result) entry.data = data;
          return data;
        })
        .catch((error) => {
          if (previews.current.get(seq)?.promise === result) previews.current.delete(seq);
          throw error;
        })
        .finally(() => requests.current.delete(abort));
      previews.current.set(seq, { promise: result });
      return result;
    },
    [transport, base, query],
  );
  return { ...index, error, preview, cached: (seq: MessageKey) => previews.current.get(seq)?.data };
}
