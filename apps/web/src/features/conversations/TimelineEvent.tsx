import type { Node } from "@intrica/contracts";
import type { ReactNode } from "react";
import { DeferredDetails } from "../../components/DeferredDetails";
import { MarkdownLite } from "../../components/MarkdownLite";
import { ToolCallDetails } from "../../components/ToolCallDetails";
import i18n, { tr } from "../../i18n";
import { Button } from "../../ui/button";
import { FileReferenceView } from "../files/FileReferenceView";
import { type Activity, activityKey } from "./model";
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
        second: "2-digit",
      })}
    </time>
  );
}

export function TimelineEvent({
  event,
  nodes,
  accessCards,
  requestEvent,
  onSelectNode,
  onOpenFile,
}: {
  event: Activity;
  nodes: ReadonlyMap<string, Node>;
  accessCards?: Array<{ id: string; card: ReactNode; pending?: boolean }> | undefined;
  requestEvent: ReadonlyMap<string, string>;
  onSelectNode?: ((id: string) => void) | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const name = (id: unknown, historicalName?: unknown) => {
    if (id === "workspace") return tr("工作区助手");
    if (typeof id !== "string" || !id || id === "unknown") return tr("未知 Agent");
    const live = nodes.get(id)?.title;
    if (live) return live;
    return typeof historicalName === "string" && historicalName
      ? tr("{{v0}}（已删除）", { v0: historicalName })
      : tr("已删除的 Agent（{{v0}}）", { v0: id.slice(-8) });
  };
  const recipients = (event: Activity): string[] =>
    event.data.from
      ? [event.agentId]
      : Array.isArray(event.data.recipients)
        ? (event.data.recipients as string[])
        : typeof event.data.to === "string"
          ? [event.data.to]
          : [];
  const recipientName = (event: Activity, id: string) =>
    name(id, (event.data.recipientNames as Record<string, string> | undefined)?.[id]);
  return (
    <>
      <small>
        {["team_notice", "run_status", "context_notice"].includes(event.kind)
          ? tr("运行通知")
          : event.kind === "permission_notice"
            ? tr("系统审批通知")
            : event.kind === "user"
              ? tr("你")
              : event.kind === "trigger"
                ? tr("协作触发")
                : name(
                    event.data.from ?? event.data.senderId ?? event.agentId,
                    event.data.senderName,
                  )}
        {["message", "report"].includes(event.kind) && recipients(event).length
          ? ` → ${recipients(event)
              .map((id) => recipientName(event, id))
              .join("、")}`
          : ""}
        {event.kind === "tool" ? " · 工具" : ""}
        {event.kind === "broadcast"
          ? tr(" \u00B7 广播给 {{v0}} 位 Agent", {
              v0: Array.isArray(event.data.recipients) ? event.data.recipients.length : 0,
            })
          : ""}
        {event.kind === "report" ? " · 最终报告" : ""}
        {event.kind === "team_notice"
          ? ` · ${name(event.data.subjectId, event.data.subjectName)}`
          : ""}
        {<EventTime value={event.createdAt} />}
      </small>
      {event.kind === "broadcast" && (
        <DeferredDetails className="broadcast-scope" summary={tr("接收者与共享资源")}>
          {() => (
            <>
              <p>
                {((event.data.recipients as string[]) ?? [])
                  .map((id) => recipientName(event, id))
                  .join("、")}
              </p>
              <p>
                {((event.data.resourceIds as string[]) ?? [])
                  .map((id) => nodes.get(id)?.title || tr("已移除的资源"))
                  .join("、")}
              </p>
            </>
          )}
        </DeferredDetails>
      )}
      {["access", "permission_notice"].includes(event.kind) &&
      requestEvent.get(String(event.data.requestId)) === activityKey(event) &&
      accessCards?.some((c) => c.id === event.data.requestId) ? (
        accessCards.find((c) => c.id === event.data.requestId)?.card
      ) : event.kind === "permission_notice" ? (
        <p>{tr("审批状态已更新，请查看权限申请。")}</p>
      ) : event.kind === "tool" ? (
        <ToolCallDetails
          data={event.data}
          onSelectNode={onSelectNode}
          onOpenFile={onOpenFile}
          nodeName={(id) => nodes.get(id)?.title || id}
        />
      ) : (
        <>
          {event.data.thinking ? (
            <DeferredDetails summary={tr("思考")}>
              {() => <p>{String(event.data.thinking)}</p>}
            </DeferredDetails>
          ) : null}
          <MarkdownLite
            origin={{
              kind: "agent",
              id: String(event.data.from ?? event.data.senderId ?? event.agentId),
            }}
            text={String(
              event.data.text ??
                event.data.reason ??
                (event.kind === "access"
                  ? ({
                      approve: tr("权限已批准，将继续工作。"),
                      deny: tr("权限已拒绝，将按现有权限继续。"),
                      revoke: tr("授权已撤销。"),
                      escalate: tr("权限申请已交给用户。"),
                    }[String(event.data.decision)] ?? tr("权限状态已更新"))
                  : ""),
            )}
          />
          {Array.isArray(event.data.fileIds) &&
            event.data.fileIds.map((id) =>
              typeof id === "string" ? (
                <FileReferenceView
                  key={id}
                  origin={{ kind: "node", id }}
                  label={
                    nodes.get(id)?.resource?.snapshot?.name ??
                    nodes.get(id)?.title ??
                    tr("查看文件")
                  }
                />
              ) : null,
            )}
          {typeof event.data.memoryNodeId === "string" &&
            nodes.has(event.data.memoryNodeId) &&
            onSelectNode && (
              <Button type="button" onClick={() => onSelectNode(event.data.memoryNodeId as string)}>
                {tr("查看会话笔记")}
              </Button>
            )}
        </>
      )}
    </>
  );
}
