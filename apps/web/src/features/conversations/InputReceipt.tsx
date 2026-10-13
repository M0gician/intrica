import { type ReactNode, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { tr } from "../../i18n";
import { PriorityControl, ReceiptStatus } from "./MessageIndicators";
import "./input-receipt.css";

export type Receipt = {
  expeditedAt?: string | null;
  consumedAt?: string | null;
  messageId: string;
  state: "sending" | "unread" | "expediting" | "read" | "closed" | "stopped" | "failed";
  consumedRunId?: string | null;
};
export function InputReceipt({
  conversationId,
  receipt,
  time,
}: {
  conversationId?: string | undefined;
  receipt?: Receipt | undefined;
  time?: ReactNode;
}) {
  const { transport, activity, signal } = useSessionConnection();
  const [expediting, setExpediting] = useState<"expediting" | "read" | null>(null),
    [error, setError] = useState("");
  if (!receipt) return time ? <span className="input-receipt">{time}</span> : null;
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
    <>
      {error && (
        <span role="alert" className="input-receipt-error">
          {error}
        </span>
      )}
      <span className="input-receipt">
        {time}
        <ReceiptStatus
          state={state}
          label={label}
          title={state === "read" ? tr("已加入模型上下文") : label}
        />
      </span>
      {((conversationId && ["unread", "expediting"].includes(state)) || receipt.expeditedAt) && (
        <PriorityControl
          active={state === "expediting" || Boolean(receipt.expeditedAt)}
          label={
            state === "expediting"
              ? tr("加急中")
              : receipt.expeditedAt
                ? state === "read"
                  ? tr("已优先送达")
                  : tr("加急中")
                : tr("加急")
          }
          disabled={state === "expediting" || Boolean(receipt.expeditedAt)}
          onClick={
            conversationId && ["unread", "expediting"].includes(state)
              ? () => void expedite()
              : undefined
          }
        />
      )}
    </>
  );
}
