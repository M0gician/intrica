import { useState } from "react";
import i18n, { tr } from "../../i18n";
import { Button } from "../../ui/button";
import { PriorityControl, ReceiptStatus } from "./MessageIndicators";
import { ReminderDelay } from "./ReminderDelay";
import { type MessageNoticeStatus, useMessageNotice } from "./useMessageNotice";
import "./message-notice.css";

function statusLabel(status: MessageNoticeStatus) {
  if (status.state === "replied") return tr("已收到回复");
  if (status.state === "cancelled" || status.tracking_stopped) return tr("已停止跟踪");
  if (status.closed) return tr("消息已关闭");
  return status.readAt ? (status.expectReply ? tr("已读，尚未回复") : tr("已读")) : tr("未读");
}

export function MessageNotice({
  deliveryIds,
  conversationId,
}: {
  deliveryIds: string[];
  conversationId?: string | undefined;
}) {
  const { statuses, pending, error, update } = useMessageNotice(deliveryIds, conversationId);
  const [seconds, setSeconds] = useState(120);
  const validDelay = Number.isInteger(seconds) && seconds >= 1 && seconds <= 604800;
  return (
    <section className="message-notice-actions" aria-label={tr("消息跟进")}>
      <div className="message-notice-heading">
        <strong>{statuses?.some((s) => s.pending) ? tr("消息需要跟进") : tr("消息跟进")}</strong>
        {statuses?.some((s) => s.pending) && <p>{tr("可以继续等待，或请对方优先处理。")}</p>}
      </div>
      {!statuses && !error && <p role="status">{tr("正在读取消息状态…")}</p>}
      {statuses?.some((s) => s.pending) && (
        <ReminderDelay seconds={seconds} onChange={setSeconds} />
      )}
      {statuses?.length === 0 && <p role="status">{tr("这些消息已不可用。")}</p>}
      <ul className="message-notice-list">
        {statuses?.map((status) => {
          const expedited = Boolean(status.expedited_at);
          const priorityPending = expedited && !status.expediteReadAt;
          const nextReminder =
            status.snoozedUntil && new Date(status.snoozedUntil).getTime() > Date.now()
              ? new Date(status.snoozedUntil).toLocaleTimeString(i18n.language, {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : null;
          return (
            <li key={status.deliveryId} aria-busy={pending?.id === status.deliveryId}>
              <div className="message-notice-recipient">
                <div className="message-notice-person">
                  {expedited && (
                    <PriorityControl
                      inline
                      active
                      label={status.expediteReadAt ? tr("已优先送达") : tr("加急中")}
                    />
                  )}
                  <strong>{status.recipientName || tr("已移除的成员")}</strong>
                </div>
                <ReceiptStatus
                  state={
                    status.closed || status.tracking_stopped || status.state === "cancelled"
                      ? "closed"
                      : status.readAt || status.state === "replied"
                        ? "read"
                        : "unread"
                  }
                  label={statusLabel(status)}
                />
              </div>
              {status.message && <blockquote>{status.message}</blockquote>}
              {status.pending && (
                <>
                  {status.paused ? (
                    <p className="message-notice-hint">{tr("对方已暂停协作，恢复后继续处理。")}</p>
                  ) : status.blocked ? (
                    <p className="message-notice-hint">{tr("对方暂时无法启动，等待恢复。")}</p>
                  ) : null}
                  {nextReminder && (
                    <p className="message-notice-hint" role="status">
                      {tr("已延后提醒，下次提醒 {{time}}", { time: nextReminder })}
                    </p>
                  )}
                  <div className="message-notice-buttons">
                    <Button
                      variant="primary"
                      disabled={Boolean(pending) || !validDelay}
                      onClick={() => void update(status, "wait", seconds)}
                    >
                      {pending?.id === status.deliveryId && pending.action === "wait"
                        ? tr("正在设置…")
                        : tr("继续等待")}
                    </Button>
                    {!status.paused && !status.blocked && !priorityPending && (
                      <PriorityControl
                        inline
                        disabled={Boolean(pending)}
                        onClick={() => void update(status, "expedite")}
                        label={
                          pending?.id === status.deliveryId && pending.action === "expedite"
                            ? tr("正在加急…")
                            : expedited
                              ? tr("再次加急")
                              : tr("加急消息")
                        }
                      />
                    )}
                    <details className="message-notice-more">
                      <summary>{tr("更多操作")}</summary>
                      <div>
                        <p>{tr("停止跟踪后不再提醒，消息和已有回复会保留。")}</p>
                        <Button
                          variant="quiet"
                          disabled={Boolean(pending)}
                          onClick={() => void update(status, "cancel")}
                        >
                          {tr("停止跟踪")}
                        </Button>
                      </div>
                    </details>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="message-action-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
