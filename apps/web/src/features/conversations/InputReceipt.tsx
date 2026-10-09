import { useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { tr } from "../../i18n";
import { Button } from "../../ui/button";
import "./input-receipt.css";

export type Receipt = {
  messageId: string;
  state: "sending" | "unread" | "expediting" | "read" | "closed" | "stopped" | "failed";
  consumedRunId?: string | null;
};
export function InputReceipt({
  conversationId,
  receipt,
}: {
  conversationId?: string | undefined;
  receipt?: Receipt | undefined;
}) {
  const { transport, activity, signal } = useSessionConnection();
  const [expediting, setExpediting] = useState<"expediting" | "read" | null>(null),
    [error, setError] = useState("");
  if (!receipt) return null;
  const state = expediting && receipt.state === "unread" ? expediting : receipt.state;
  const label = {
    sending: tr("发送中"),
    unread: tr("未读"),
    expediting: tr("加急中"),
    read: tr("已读"),
    closed: tr("输入已关闭"),
    stopped: tr("输入等待继续"),
    failed: tr("发送失败"),
  }[state];
  const expedite = async () => {
    setExpediting("expediting");
    setError("");
    try {
      const result = await transport.json<{ state: "expediting" | "read" }>(
        "POST",
        `/api/v2/conversations/${encodeURIComponent(conversationId!)}/expedite`,
        { messageId: receipt.messageId },
      );
      if (!signal.aborted) {
        setExpediting(result.state);
        activity.invalidate({ conversationId: conversationId! });
      }
    } catch (error) {
      if (!signal.aborted) {
        setExpediting(null);
        setError(error instanceof Error ? error.message : String(error));
      }
    }
  };
  return (
    <span className="input-receipt">
      <span
        role="status"
        aria-label={label}
        title={state === "read" ? tr("已加入模型上下文") : label}
      >
        <svg
          width="18"
          height="14"
          viewBox="0 0 20 14"
          fill="none"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path d="m1 7 4 4 8-9" />
          {state === "read" && <path d="m7 7 4 4 8-9" />}
        </svg>
        {label}
      </span>
      {conversationId && ["unread", "expediting"].includes(state) && (
        <Button
          variant="quiet"
          size="icon"
          className="input-expedite"
          disabled={state === "expediting"}
          aria-label={state === "expediting" ? tr("加急中") : tr("加急")}
          title={state === "expediting" ? tr("加急中") : tr("加急")}
          onClick={() => void expedite()}
        >
          <svg width="17" height="19" viewBox="0 0 18 22" fill="currentColor" aria-hidden="true">
            <path d="M10.5 1 2 12h5l-1 9 10-13h-6l.5-7Z" />
          </svg>
        </Button>
      )}
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
