import type { InputAssociation, MessageRequestView } from "@intrica/contracts";
import { useState } from "react";
import { tr } from "../../i18n";
import { InputReceipt, type Receipt } from "./InputReceipt";

export function useMessageAssociation(requests: MessageRequestView[] = []) {
  const [selected, setSelected] = useState("new");
  const choices = requests.filter(
    (r) => r.state === "open" && (r.direction === "incoming" || r.recipientKind === "user"),
  );
  const valid = choices.some(
    (r) => `${r.recipientKind === "user" ? "reply" : "append"}:${r.id}` === selected,
  );
  const value = valid ? selected : "new";
  const association: InputAssociation =
    value === "new"
      ? { kind: "new" }
      : {
          kind: value.startsWith("reply:") ? "reply" : "append",
          requestId: value.slice(value.indexOf(":") + 1),
        };
  return { association, value, setSelected, choices };
}

export function MessageAssociation({
  routing,
}: {
  routing: ReturnType<typeof useMessageAssociation>;
}) {
  if (!routing.choices.length) return null;
  return (
    <label className="message-association">
      <span>{tr("这条输入用于")}</span>
      <select
        aria-label={tr("输入归属")}
        value={routing.value}
        onChange={(e) => routing.setSelected(e.target.value)}
      >
        <option value="new">{tr("新问题")}</option>
        {routing.choices.map((r) => (
          <option key={r.id} value={`${r.recipientKind === "user" ? "reply" : "append"}:${r.id}`}>
            {r.recipientKind === "user"
              ? tr("回复追问")
              : r.workState === "active"
                ? tr("补充当前任务")
                : tr("补充任务")}{" "}
            · {r.summary || r.senderName}
          </option>
        ))}
      </select>
    </label>
  );
}

const stateLabel = (state: string) =>
  ({
    open: tr("待回复"),
    answered: tr("已回复"),
    declined: tr("已拒绝"),
    cancelled: tr("已取消"),
    unavailable: tr("无法继续"),
  })[state] ?? state;
export function MessageStatus({ data }: { data: Record<string, unknown> }) {
  const requests = data.messageRequests as
    | Array<{ id: string; state: string; blockedReason?: string | null; summary?: string }>
    | undefined;
  return (
    <>
      {requests?.map((r) => (
        <small className="message-request-state" key={r.id} title={r.id}>
          {data.inReplyTo === r.id ? `${tr("回复原请求")} · ` : ""}
          {stateLabel(r.state)}
          {r.blockedReason ? ` · ${reasonLabel(r.blockedReason)}` : ""}
          {data.inReplyTo === r.id && r.summary ? ` · ${r.summary}` : ""}
        </small>
      ))}
      {Array.isArray(data.deliveries) && data.deliveries.length > 0 && (
        <small className="message-delivery-state">
          {tr("已送达")}
          {data.deliveries.some((r: any) => r.state !== "delivered") && (
            <>
              {" "}
              ·{" "}
              {tr("已读 {{v0}} / {{v1}}", {
                v0: data.deliveries.filter((r: any) => r.state === "read").length,
                v1: data.deliveries.filter((r: any) => r.state !== "delivered").length,
              })}
            </>
          )}
          {!data.from &&
            data.deliveries
              .filter((r: any) => r.state !== "delivered")
              .map((r: any) => (
                <InputReceipt
                  key={`${r.conversationId}:${r.messageId}`}
                  conversationId={r.conversationId}
                  receipt={r as Receipt}
                />
              ))}
        </small>
      )}
    </>
  );
}
export function reasonLabel(reason: string) {
  return (
    {
      tool_input: tr("工具参数需要修正"),
      unknown: tr("请先核实未知工具结果"),
      tool_contract_upgrade: tr("会话因升级暂停"),
      activation_limit: tr("自动协作已达到上限"),
      reply_required: tr("尚未提交答复"),
      message: tr("等待协作结果"),
      message_protocol: tr("输出格式无效，尚未发送"),
      stopped: tr("已停止"),
      model_not_configured: tr("请配置模型"),
      agent_deleted: tr("Agent 已删除"),
      permissions_changed: tr("权限已变化"),
      context_reset: tr("上下文已重置"),
    }[reason] ?? reason
  );
}
export function PendingMessages({
  requests = [],
}: {
  requests?: MessageRequestView[] | undefined;
}) {
  const pending = requests.filter((r) => r.state === "open");
  if (!pending.length) return null;
  return (
    <details className="message-pending">
      <summary>
        {tr("待回复请求")} · {pending.length}
      </summary>
      <ul>
        {pending.map((r) => (
          <li key={r.id}>
            <span>
              {r.direction === "incoming" ? tr("待处理") : tr("等待答复")} ·{" "}
              {r.summary || r.recipientName}
            </span>
            {r.blockedReason && <small>{reasonLabel(r.blockedReason)}</small>}
          </li>
        ))}
      </ul>
    </details>
  );
}
