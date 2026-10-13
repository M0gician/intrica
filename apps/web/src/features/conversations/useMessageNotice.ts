import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionConnection } from "../../api/connection";

export type MessageNoticeStatus = {
  deliveryId: string;
  recipientName?: string;
  message?: string;
  state: string;
  version: number;
  readAt: string | null;
  pending: boolean;
  expectReply: boolean;
  tracking_stopped: boolean;
  closed?: boolean;
  paused: boolean;
  blocked: boolean;
  expedited_at?: string | null;
  expediteReadAt?: string | null;
  snoozedUntil?: string | null;
};
type Action = "wait" | "expedite" | "cancel";

/** A coalesced notice shares one status request and one live subscription. */
export function useMessageNotice(deliveryIds: string[], conversationId?: string) {
  const connection = useSessionConnection();
  const key = deliveryIds.join(",");
  const scope = `${connection.bindingId}:${key}`;
  const current = useRef(scope);
  current.current = scope;
  const [snapshot, setSnapshot] = useState<{ scope: string; statuses: MessageNoticeStatus[] }>();
  const [pending, setPending] = useState<{ id: string; action: Action } | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(
    (signal?: AbortSignal) =>
      connection.transport.request<MessageNoticeStatus[]>(
        `/api/v2/message-deliveries?ids=${encodeURIComponent(key)}`,
        signal ? { signal } : undefined,
      ),
    [connection, key],
  );
  useEffect(() => {
    const abort = new AbortController();
    setError("");
    setPending(null);
    const load = async () => {
      try {
        const statuses = await refresh(abort.signal);
        if (!abort.signal.aborted) {
          setSnapshot({ scope, statuses });
          setError("");
        }
      } catch (e) {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      }
    };
    const unsubscribe = conversationId
      ? connection.activity.follow({ kind: "conversation", id: conversationId }, load)
      : undefined;
    if (!conversationId) void load();
    return () => {
      abort.abort();
      unsubscribe?.();
    };
  }, [connection, conversationId, refresh, scope]);
  const update = async (status: MessageNoticeStatus, action: Action, seconds = 120) => {
    if (pending) return;
    setPending({ id: status.deliveryId, action });
    setError("");
    try {
      await connection.transport.json(
        "POST",
        `/api/v2/message-deliveries/${encodeURIComponent(status.deliveryId)}`,
        {
          action,
          version: status.version,
          ...(action === "wait" ? { waitSeconds: seconds } : {}),
        },
      );
      const statuses = await refresh(connection.signal);
      if (current.current === scope) setSnapshot({ scope, statuses });
    } catch (e) {
      if (current.current === scope && !connection.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e));
        void refresh(connection.signal)
          .then((statuses) => {
            if (current.current === scope) setSnapshot({ scope, statuses });
          })
          .catch(() => {});
      }
    } finally {
      if (current.current === scope) setPending(null);
    }
  };
  return { statuses: snapshot?.scope === scope ? snapshot.statuses : null, pending, error, update };
}
