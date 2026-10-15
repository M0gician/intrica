import type { ModelRequestStatus } from "@intrica/contracts";
import { useEffect, useState } from "react";
import { tr } from "../../i18n";

export function ConversationPause({
  reason,
  modelRequest,
}: {
  reason?: string | null | undefined;
  modelRequest?: ModelRequestStatus | null | undefined;
}) {
  const [now, setNow] = useState(Date.now());
  const retryAt = modelRequest?.nextAttemptAt;
  useEffect(() => {
    if (!retryAt || !["model_queued", "model_retry"].includes(reason ?? "")) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [retryAt, reason]);
  const seconds = retryAt ? Math.max(0, Math.ceil((Date.parse(retryAt) - now) / 1000)) : 0;
  if (reason === "context_blocked")
    return (
      <p role="status" className="conversation-pause">
        {tr("上下文整理未完成，任务已暂停。原始记录已保留，点击继续后将重新规划整理。")}
      </p>
    );
  if (reason === "model_retry" && modelRequest?.reason === "CONTEXT_SUMMARY_INVALID")
    return (
      <p role="status" className="conversation-pause">
        {tr("摘要未通过校验，正在根据具体原因修正。")}
      </p>
    );
  if (reason === "model_retry" && modelRequest?.reason === "MODEL_INTERRUPTED")
    return (
      <p role="status" className="conversation-pause">
        {tr("正在恢复中断的模型请求，任务将自动继续。")}
      </p>
    );
  if (
    reason?.startsWith("CONTEXT_SUMMARY_INVALID") ||
    (modelRequest?.state === "failed" && modelRequest.reason === "CONTEXT_SUMMARY_INVALID")
  )
    return (
      <p role="status" className="conversation-pause">
        {tr("摘要未通过校验，本次压缩未生效，原始上下文已保留。")}
      </p>
    );
  if (reason === "progress_review" || reason === "inbox_review")
    return (
      <p role="status" className="conversation-pause">
        {tr("Agent 需要检查未读消息和待回复请求。点击继续以完成检查。")}
      </p>
    );
  if (reason === "progress_blocked")
    return (
      <p role="status" className="conversation-pause">
        {tr("任务仍有未完成工作，等待阻碍解除。")}
      </p>
    );
  if (reason === "model_queued" || reason === "model_retry")
    return (
      <p role="status" className="conversation-pause">
        {seconds > 0
          ? tr("模型服务繁忙，将在 {{v0}} 秒后重试。", { v0: seconds })
          : tr(
              reason === "model_queued"
                ? "模型请求排队中，任务将自动继续。"
                : "模型服务繁忙，正在等待重试。",
            )}
      </p>
    );
  if (reason !== "tool_contract_upgrade") return null;
  return (
    <p role="status" className="tool-summary-note conversation-pause">
      {tr("此会话因升级暂停。请先核实未知结果，再点击继续，以当前工具和权限开始新运行。")}
    </p>
  );
}
