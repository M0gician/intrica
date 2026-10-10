import { useEffect, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { tr } from "../../i18n";
import { Button } from "../../ui/button";
import { reasonLabel } from "./MessageRouting";
import "./conversation-diagnostics.css";

export type MessageWait = {
  waitId: string;
  mode: string;
  deadline: string | null;
  blockedReason: string | null;
  requests: Array<{
    id: string;
    recipientName: string;
    recipientAgentId: string;
    receipt: string;
    elapsedSeconds: number;
    followupCount: number;
    workState: string;
  }>;
};
export function ConversationWaits({
  conversationId,
  waits = [],
}: {
  conversationId: string | null;
  waits?: MessageWait[] | undefined;
}) {
  const { transport, activity } = useSessionConnection();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!waits.some((w) => w.deadline)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waits]);
  if (!waits.length && !error) return null;
  const control = async (waitId: string, action: "wake" | "cancel") => {
    setBusy(waitId);
    setError("");
    try {
      await transport.json(
        "POST",
        `/api/v2/conversations/${encodeURIComponent(conversationId!)}/waits/${encodeURIComponent(waitId)}`,
        { action },
      );
      activity.invalidate({ conversationId: conversationId! });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="conversation-waits" aria-label={tr("消息等待")}>
      {error && <p role="alert">{error}</p>}
      {waits.map((wait) => (
        <div key={wait.waitId} className="conversation-wait">
          <strong>
            {wait.mode === "requests"
              ? tr("等待答复")
              : wait.mode === "idle"
                ? tr("等待新任务")
                : tr("等待外部输入")}
          </strong>
          <span>
            {wait.deadline
              ? tr("剩余 {{v0}} 秒", {
                  v0: Math.max(0, Math.ceil((new Date(wait.deadline).getTime() - now) / 1000)),
                })
              : tr("未设截止时间")}
          </span>
          {wait.deadline && (
            <time dateTime={wait.deadline}>{new Date(wait.deadline).toLocaleString()}</time>
          )}
          {wait.requests.map((r) => (
            <p key={r.id}>
              {r.recipientName || r.recipientAgentId} ·{" "}
              {r.receipt === "read" ? tr("已读") : tr("未读")} ·{" "}
              {tr("已跟进 {{v0}} 次", { v0: r.followupCount })}
            </p>
          ))}
          {wait.blockedReason && <p role="status">{reasonLabel(wait.blockedReason)}</p>}
          <div className="conversation-wait-actions">
            <Button
              disabled={
                Boolean(busy) ||
                Boolean(wait.blockedReason && wait.blockedReason !== "activation_limit")
              }
              onClick={() => void control(wait.waitId, "wake")}
            >
              {tr("现在唤醒")}
            </Button>
            <Button disabled={Boolean(busy)} onClick={() => void control(wait.waitId, "cancel")}>
              {tr("取消等待")}
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}
