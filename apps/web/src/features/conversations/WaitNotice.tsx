import { tr } from "../../i18n";

export function waitNoticeLabel(reason: unknown) {
  return (
    {
      timeout: tr("等待已到期"),
      message: tr("收到等待的回复"),
      request_closed: tr("依赖请求已结束"),
      wake: tr("已请求继续执行"),
      cancel: tr("等待已取消"),
    }[String(reason)] ?? tr("运行通知")
  );
}
export function WaitNotice({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="wait-notice" role="status">
      <strong>{waitNoticeLabel(data.reason)}</strong>
      <p>{tr("已等待 {{v0}} 秒", { v0: Number(data.waitedSeconds ?? 0) })}</p>
      {Array.isArray(data.requests) &&
        data.requests.map((r: any) => (
          <p key={r.id}>
            {r.recipientName || r.recipientAgentId || tr("用户")} ·{" "}
            {r.receipt === "read" ? tr("已读") : tr("未读")} ·{" "}
            {tr("已跟进 {{v0}} 次", { v0: r.followupCount })}
          </p>
        ))}
    </div>
  );
}
