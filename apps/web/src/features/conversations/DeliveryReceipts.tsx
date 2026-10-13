import type { CollaborationReceipt } from "@intrica/contracts";
import { useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { tr } from "../../i18n";
import { Button } from "../../ui/button";

export function DeliveryReceipts({
  receipts,
  conversationId,
}: {
  receipts: CollaborationReceipt[];
  conversationId?: string | undefined;
}) {
  const connection = useSessionConnection();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (!receipts.length) return null;
  const expedite = async (receipt: CollaborationReceipt) => {
    setBusy(receipt.deliveryId);
    setError("");
    try {
      await connection.transport.json(
        "POST",
        `/api/v2/message-deliveries/${encodeURIComponent(receipt.deliveryId)}`,
        { action: "expedite", version: receipt.version, waitSeconds: 120 },
      );
      if (conversationId) connection.activity.invalidate({ conversationId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const render = (r: CollaborationReceipt) => (
    <li key={r.deliveryId} className="delivery-receipt">
      <span>{r.recipientName || tr("已移除的成员")}</span>
      <span
        role="status"
        title={
          r.readAt
            ? `${tr("已加入模型上下文")} · ${new Date(r.readAt).toLocaleString()}`
            : undefined
        }
      >
        {r.replied
          ? tr("已回复")
          : r.state === "closed"
            ? tr("消息已关闭")
            : r.state === "read"
              ? tr("已读")
              : tr("未读")}
        {!r.replied && r.expectReply && r.tracking ? ` · ${tr("等待回复")}` : ""}
        {r.paused ? ` · ${tr("协作已暂停")}` : r.blocked ? ` · ${tr("等待调度")}` : ""}
      </span>
      {r.priority === "expedited" && (
        <span className="message-priority">
          ⚡ {r.expediteReadAt ? tr("已优先送达") : tr("加急中")}
        </span>
      )}
      {r.tracking && !r.paused && !r.blocked && (
        <Button variant="quiet" disabled={busy !== null} onClick={() => void expedite(r)}>
          {busy === r.deliveryId ? tr("加急中") : tr("加急消息")}
        </Button>
      )}
    </li>
  );
  return (
    <div className="delivery-receipts">
      {receipts.length === 1 ? (
        <ul>{receipts.map(render)}</ul>
      ) : (
        <details>
          <summary>
            {tr("已读 {{read}}/{{total}}", {
              read: receipts.filter((r) => r.state === "read").length,
              total: receipts.length,
            })}
          </summary>
          <ul>{receipts.map(render)}</ul>
        </details>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
