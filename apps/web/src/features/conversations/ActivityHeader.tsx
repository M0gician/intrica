import type { Node } from "@intrica/contracts";
import i18n, { tr } from "../../i18n";
import { PriorityControl } from "./MessageIndicators";
import { isExpedited } from "./message-priority";
import type { Activity } from "./model";

export function participantName(
  nodes: ReadonlyMap<string, Node>,
  id: unknown,
  historicalName?: unknown,
) {
  if (id === "workspace") return tr("工作区助手");
  if (typeof id !== "string" || !id || id === "unknown") return tr("未知 Agent");
  const live = nodes.get(id)?.title;
  if (live) return live;
  return typeof historicalName === "string" && historicalName
    ? tr("{{v0}}（已删除）", { v0: historicalName })
    : tr("已删除的 Agent（{{v0}}）", { v0: id.slice(-8) });
}
export function recipientName(event: Activity, nodes: ReadonlyMap<string, Node>, id: string) {
  return participantName(
    nodes,
    id,
    (event.data.recipientNames as Record<string, string> | undefined)?.[id],
  );
}
export function EventTime({ value }: { value: Activity["createdAt"] }) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <time
      className="agent-event-time"
      dateTime={date.toISOString()}
      title={date.toLocaleString(i18n.language)}
    >
      {date.toLocaleString(i18n.language, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })}
    </time>
  );
}
export function ActivityHeader({
  event,
  nodes,
}: {
  event: Activity;
  nodes: ReadonlyMap<string, Node>;
}) {
  const hasReceipts =
    Array.isArray(event.data.deliveryReceipts) && event.data.deliveryReceipts.length > 0;
  const priority = isExpedited(event) && !hasReceipts;
  if (event.kind === "user")
    return priority && !event.data.inputReceipt ? (
      <PriorityControl active label={tr("加急")} />
    ) : null;
  const system: Record<string, string> = {
    team_notice: tr("团队通知"),
    run_status: tr("运行通知"),
    context_notice: tr("运行通知"),
    message_notice: tr("跟进提醒"),
    permission_notice: tr("系统审批通知"),
    trigger: tr("资源与定时任务"),
    completion_review: tr("结束前检查"),
  };
  const author =
    system[event.kind] ??
    participantName(
      nodes,
      event.data.from ?? event.data.senderId ?? event.agentId,
      event.data.senderName,
    );
  const recipients: string[] = event.data.from
    ? [event.agentId]
    : Array.isArray(event.data.recipients)
      ? (event.data.recipients as string[])
      : typeof event.data.to === "string"
        ? [event.data.to]
        : [];
  const target =
    recipients.length > 2
      ? tr("{{count}} 位成员", { count: recipients.length })
      : recipients.map((id) => recipientName(event, nodes, id)).join("、");
  return (
    <header className="activity-header">
      <div className="activity-participants">
        <strong>{author}</strong>
        {["message", "report", "broadcast"].includes(event.kind) && target && (
          <span>{tr("发给 {{name}}", { name: target })}</span>
        )}
        {event.kind === "team_notice" && (
          <span>{participantName(nodes, event.data.subjectId, event.data.subjectName)}</span>
        )}
      </div>
      <div className="activity-header-meta">
        {priority && <PriorityControl active label={tr("加急")} />}
        {event.kind === "tool" && <span>{tr("工具")}</span>}
        {event.kind === "report" && <span>{tr("结果汇报")}</span>}
        {!hasReceipts && <EventTime value={event.createdAt} />}
      </div>
    </header>
  );
}
