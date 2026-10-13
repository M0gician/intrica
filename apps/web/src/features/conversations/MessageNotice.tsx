import { useEffect, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { tr } from "../../i18n";
import { Button } from "../../ui/button";

type Status = { state: string; version: number; readAt: string | null; runState: string | null };
export function MessageNotice({
  requestId,
  conversationId,
}: {
  requestId: string;
  conversationId?: string | undefined;
}) {
  const connection = useSessionConnection();
  const [status, setStatus] = useState<Status>();
  const [seconds, setSeconds] = useState(120);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = () =>
    connection.transport.request<Status>(
      `/api/v2/message-requests/${encodeURIComponent(requestId)}`,
    );
  useEffect(() => {
    const abort = new AbortController();
    const load = async () => {
      try {
        const value = await connection.transport.request<Status>(
          `/api/v2/message-requests/${encodeURIComponent(requestId)}`,
          { signal: abort.signal },
        );
        if (!abort.signal.aborted) setStatus(value);
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
  }, [connection, requestId, conversationId]);
  const update = async (action: "wait" | "expedite" | "cancel") => {
    if (!status || busy) return;
    setBusy(true);
    setError("");
    try {
      await connection.transport.json(
        "POST",
        `/api/v2/message-requests/${encodeURIComponent(requestId)}`,
        { action, version: status.version, waitSeconds: seconds },
      );
      setStatus(await refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      void refresh()
        .then(setStatus)
        .catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="message-notice-actions">
      {status && (
        <p>
          {status.state === "replied"
            ? tr("已收到回复")
            : status.state === "cancelled"
              ? tr("已取消跟踪")
              : status.readAt
                ? tr("已读，尚未回复")
                : tr("尚未读入上下文")}
        </p>
      )}
      {status?.state === "open" && (
        <>
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
          <Button
            disabled={busy || !Number.isInteger(seconds) || seconds < 1 || seconds > 604800}
            onClick={() => void update("wait")}
          >
            {tr("继续等待")}
          </Button>
          <Button
            disabled={busy || !Number.isInteger(seconds) || seconds < 1 || seconds > 604800}
            onClick={() => void update("expedite")}
          >
            {tr("加急消息")}
          </Button>
          <Button disabled={busy} onClick={() => void update("cancel")}>
            {tr("取消跟踪")}
          </Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
