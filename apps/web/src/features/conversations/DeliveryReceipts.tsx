import type { CollaborationReceipt } from "@intrica/contracts";
import { type ReactNode, useId, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { tr } from "../../i18n";
import { PriorityControl, ReceiptIcon, ReceiptStatus } from "./MessageIndicators";
import "./collaboration.css";

function labelFor(r: CollaborationReceipt) {
  return r.replied
    ? tr("已回复")
    : r.state === "closed"
      ? tr("消息已关闭")
      : r.state === "read"
        ? tr("已读")
        : tr("未读");
}
function receiptHint(r: CollaborationReceipt) {
  return [
    labelFor(r),
    r.readAt ? `${tr("已加入模型上下文")} · ${new Date(r.readAt).toLocaleString()}` : "",
    r.state === "closed" && r.tracking
      ? tr("此消息已关闭，请核查结果并处理未完成事项。")
      : !r.replied && r.expectReply && r.tracking
        ? tr("等待回复")
        : "",
    r.paused
      ? tr("对方已暂停协作，恢复后继续处理。")
      : r.blocked
        ? tr("对方暂时无法启动，等待恢复。")
        : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
export function DeliveryReceipts({
  receipts,
  conversationId,
  time,
}: {
  receipts: CollaborationReceipt[];
  conversationId?: string | undefined;
  time?: ReactNode;
}) {
  const connection = useSessionConnection();
  const [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null),
    [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (!receipts.length) return null;
  const expedite = async (r: CollaborationReceipt) => {
    setBusy(r.deliveryId);
    setError("");
    try {
      await connection.transport.json(
        "POST",
        `/api/v2/message-deliveries/${encodeURIComponent(r.deliveryId)}`,
        { action: "expedite", version: r.version, waitSeconds: 120 },
      );
      setSubmitted(`${r.deliveryId}:${r.version}`);
      if (conversationId) connection.activity.invalidate({ conversationId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const priority = (r: CollaborationReceipt, inline = false) => {
    const active = r.priority === "expedited" || submitted === `${r.deliveryId}:${r.version}`;
    const canAct =
      r.state !== "closed" &&
      r.tracking &&
      !r.paused &&
      !r.blocked &&
      (!active || Boolean(r.expediteReadAt));
    if (!active && !canAct) return null;
    return (
      <PriorityControl
        inline={inline}
        active={active}
        disabled={busy !== null}
        label={
          busy === r.deliveryId
            ? tr("正在加急…")
            : active
              ? r.expediteReadAt
                ? canAct
                  ? tr("再次加急")
                  : tr("已优先送达")
                : tr("加急中")
              : tr("加急消息")
        }
        onClick={canAct ? () => void expedite(r) : undefined}
      />
    );
  };
  const first = receipts[0]!;
  const read = receipts.filter((r) => r.state === "read" || r.replied).length;
  const summary = tr("已读 {{read}}/{{total}}", { read, total: receipts.length });
  const summaryState = read === receipts.length ? "read" : "unread";
  return (
    <>
      {error && (
        <p className="input-receipt-error message-action-error" role="alert">
          {error}
        </p>
      )}
      {expanded && receipts.length > 1 && (
        <ul id={listId} className="delivery-recipients-list">
          {receipts.map((r) => (
            <li key={r.deliveryId}>
              <div className="delivery-recipient-identity">
                <strong>{r.recipientName || tr("已移除的成员")}</strong>
                {r.paused ? (
                  <small>{tr("对方已暂停协作，恢复后继续处理。")}</small>
                ) : r.blocked ? (
                  <small>{tr("对方暂时无法启动，等待恢复。")}</small>
                ) : null}
              </div>
              <div className="delivery-recipient-icons">
                {priority(r, true)}
                <ReceiptStatus
                  state={r.state === "closed" ? "closed" : r.replied ? "read" : r.state}
                  label={labelFor(r)}
                  title={receiptHint(r)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      <span className="input-receipt delivery-receipts">
        {time}
        {receipts.length === 1 ? (
          <ReceiptStatus
            state={first.replied ? "read" : first.state}
            label={labelFor(first)}
            title={receiptHint(first)}
          />
        ) : (
          <button
            type="button"
            className="delivery-receipt-summary"
            aria-expanded={expanded}
            aria-controls={expanded ? listId : undefined}
            aria-label={`${tr("接收者状态")} · ${summary}`}
            title={`${tr("接收者状态")} · ${summary}`}
            onClick={() => setExpanded(!expanded)}
          >
            <ReceiptIcon state={summaryState} />
            <span>
              {read}/{receipts.length}
            </span>
          </button>
        )}
      </span>
      {receipts.length === 1
        ? priority(first)
        : receipts.some(
            (r) => r.priority === "expedited" || submitted === `${r.deliveryId}:${r.version}`,
          ) && <PriorityControl active label={tr("含加急消息")} />}
    </>
  );
}
