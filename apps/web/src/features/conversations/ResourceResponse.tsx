import type { ResourceResponseStatus } from "@intrica/contracts";
import { tr, useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import "./resource-response.css";

export function ResourceResponse({
  status,
  busy,
  onRetry,
}: {
  status?: ResourceResponseStatus | null | undefined;
  busy: boolean;
  onRetry: (revision: string) => void;
}) {
  useTranslation();
  if (!status) return null;
  const reasons = {
    model_not_configured: tr("资源响应等待模型配置。请先选择可用模型。"),
    activation_limit: tr("资源响应已达自动协作上限。发送新任务后可重试。"),
    source_missing: tr("资源响应的来源运行不可用。新的资源变化可以重新触发。"),
    queue_full: tr("资源响应正在等待队列空位，将自动重试。"),
    retry_pending: tr("资源响应暂时无法启动，将自动重试。"),
    legacy_configuration: tr("升级前的资源响应已保留。配置模型后可重试。"),
    stopped: tr("旧资源响应已停止。新的资源变化仍会触发。"),
    disabled: tr("持续协作已关闭，待处理的资源响应已取消。"),
    permissions_changed: tr("权限已变化，旧资源响应已取消。"),
    legacy_inactive: tr("升级前未启用的资源响应已取消。"),
  };
  const states = {
    pending: tr("资源响应等待处理。"),
    queued: tr("资源变化已排队，等待 Agent 读取。"),
    consumed: tr("Agent 已读取最近的资源变化。"),
    cancelled: tr("旧资源响应已取消。"),
    blocked: tr("资源响应暂时无法启动。"),
  };
  return (
    <div className="resource-response" data-state={status.state}>
      <p role="status">{status.reason ? reasons[status.reason] : states[status.state]}</p>
      {status.canRetry && (
        <Button
          type="button"
          variant="quiet"
          size="small"
          disabled={busy}
          onClick={() => onRetry(status.revision)}
        >
          {tr("重试资源响应")}
        </Button>
      )}
    </div>
  );
}
