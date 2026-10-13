import { useCallback, useEffect, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { tr } from "../../i18n";
import { Button } from "../../ui/button";

type Status = {
  deliveryId: string;
  recipientName?: string;
  state: string;
  version: number;
  readAt: string | null;
  pending: boolean;
  expectReply: boolean;
  tracking_stopped: boolean;
  paused: boolean;
  blocked: boolean;
};
/** One status request and one subscription for a coalesced reminder, regardless of audience size. */
export function MessageNotice({
  deliveryIds,
  conversationId,
}: {
  deliveryIds: string[];
  conversationId?: string | undefined;
}) {
  const connection = useSessionConnection();
  const key = deliveryIds.join(",");
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [seconds, setSeconds] = useState(120);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(
    (signal?: AbortSignal) =>
      connection.transport.request<Status[]>(
        `/api/v2/message-deliveries?ids=${encodeURIComponent(key)}`,
        signal ? { signal } : undefined,
      ),
    [connection, key],
  );
  useEffect(() => {
    const abort = new AbortController();
    const load = async () => {
      try {
        const value = await refresh(abort.signal);
        if (!abort.signal.aborted) {
          setStatuses(value);
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
  }, [connection, conversationId, refresh]);
  const update = async (status: Status, action: "wait" | "expedite" | "cancel") => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await connection.transport.json(
        "POST",
        `/api/v2/message-deliveries/${encodeURIComponent(status.deliveryId)}`,
        { action, version: status.version, waitSeconds: seconds },
      );
      setStatuses(await refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      void refresh()
        .then(setStatuses)
        .catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || !Number.isInteger(seconds) || seconds < 1 || seconds > 604800;
  return (
    <section className="message-notice-actions">
      {statuses.some((s) => s.pending) && (
        <label>
          {tr("等待秒数")}{" "}
          <input
            type="number"
            min={1}
            max={604800}
            value={seconds}
            onChange={(e) => setSeconds(Number(e.target.value))}
          />
        </label>
      )}
      {statuses.map((status) => (
        <div key={status.deliveryId}>
          {statuses.length > 1 && <strong>{status.recipientName ?? tr("成员")}</strong>}
          <p>
            {status.state === "replied"
              ? tr("已收到回复")
              : status.state === "cancelled" || status.tracking_stopped
                ? tr("已停止跟踪")
                : status.readAt
                  ? status.expectReply
                    ? tr("已读，尚未回复")
                    : tr("已读")
                  : tr("尚未读入上下文")}
          </p>
          {status.pending && (
            <>
              <Button disabled={disabled} onClick={() => void update(status, "wait")}>
                {tr("继续等待")}
              </Button>
              <Button
                disabled={disabled || status.paused || status.blocked}
                onClick={() => void update(status, "expedite")}
              >
                {tr("加急消息")}
              </Button>
              <Button disabled={busy} onClick={() => void update(status, "cancel")}>
                {tr("停止跟踪")}
              </Button>
            </>
          )}
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
