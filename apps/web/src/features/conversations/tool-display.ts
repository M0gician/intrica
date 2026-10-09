import { tr } from "../../i18n";
export function toolStatusLabel(status: string) {
  return ownLabel(
    {
      pending: tr("准备中"),
      prepared: tr("准备中"),
      running: tr("执行中"),
      dispatching: tr("执行中"),
      background: tr("后台执行中"),
      waiting: tr("等待处理"),
      unknown: tr("结果待核实"),
      error: tr("失败"),
      complete: tr("完成"),
      stopped: tr("已停止"),
      cancelled: tr("已停止"),
    },
    status,
    status,
  );
}
export function toolResultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "content" in value && Array.isArray(value.content))
    return value.content
      .filter(isRecord)
      .map((part) =>
        part.type === "text"
          ? typeof part.text === "string"
            ? part.text
            : ""
          : typeof part.type === "string"
            ? `[${part.type}]`
            : "",
      )
      .join("\n");
  return value === undefined ? "" : JSON.stringify(value, null, 2);
}

type ToolEvent = {
  kind: string;
  data: Record<string, unknown>;
  conversationId?: string;
  agentId?: string;
};
/** Delivery wakes the model, but belongs to the original operation in the UI.
 * Use durable call IDs across user turns and history pages. A callback-only page
 * still shows a compact tool card; its model-facing prose is never rendered. */
export function coalesceToolEvents<T extends ToolEvent>(events: T[]): T[] {
  const rows: T[] = [];
  const calls = new Map<string, number>();
  for (const event of events) {
    if (!["tool", "tool_update"].includes(event.kind)) {
      rows.push(event);
      continue;
    }
    const key = `${event.conversationId ?? event.agentId ?? ""}:${event.data.callId ?? event.data.id}`;
    const normalized = { ...event, kind: "tool", data: { ...event.data, text: undefined } };
    if (!event.data.callId && !event.data.id) {
      rows.push(normalized);
      continue;
    }
    const index = calls.get(key);
    if (index === undefined) {
      calls.set(key, rows.length);
      rows.push(normalized);
    } else {
      const previous = rows[index]!;
      const terminal = ["complete", "error", "succeeded", "failed", "unknown"].includes(
        String(previous.data.status),
      );
      const obsoleteProgress = terminal && event.data.progress === true;
      rows[index] = {
        ...previous,
        data: obsoleteProgress
          ? previous.data
          : {
              ...previous.data,
              ...normalized.data,
              ...(event.kind === "tool_update" &&
              terminal &&
              previous.data.result &&
              String(previous.data.status)
                .replace("complete", "succeeded")
                .replace("error", "failed") ===
                String(event.data.status)
                  .replace("complete", "succeeded")
                  .replace("error", "failed")
                ? { result: previous.data.result, truncated: previous.data.truncated }
                : {}),
            },
      };
    }
  }
  return rows;
}

export function toolLabel(name: string) {
  const labels: Record<string, string> = {
    bash: tr("运行命令"),
    read: tr("读取"),
    rg: tr("搜索文件内容"),
    read_canvas: tr("读取画布"),
    update_node: tr("更新节点"),
    create_artifact: tr("保存产物"),
    hire_agent: tr("招募 Agent"),
    configure_agent: tr("配置 Agent"),
    get_agent_status: tr("查看 Agent 状态"),
    get_tool_result: tr("查看工具结果"),
    read_conversation: tr("读取会话"),
    request_permission: tr("申请权限"),
    list_access_requests: tr("查看权限申请"),
    review_access_request: tr("审查权限申请"),
    edit: tr("编辑文件"),
    write: tr("写入文件"),
    report_result: tr("提交报告"),
    send_message: tr("发送协作消息"),
    wait_for_message: tr("等待消息"),
    web_search: tr("搜索网页"),
  };
  return ownLabel(labels, name, name);
}

export function toolOutcomeLabel(data: Record<string, unknown>) {
  const status = typeof data.status === "string" ? data.status : "";
  if (data.approvalStatus === "expired") return tr("审批已过期 · 未执行");
  if (data.approvalStatus === "denied") return tr("审批已拒绝 · 未执行");
  if (data.approvalStatus === "cancelled") return tr("审批已取消 · 未执行");
  if (data.approvalStatus === "invalidated") return tr("权限条件已变化 · 未执行");
  if (data.waitingReason === "approval") return tr("等待审批");
  if (status === "prepared" && ["approved", "satisfied"].includes(String(data.approvalStatus)))
    return tr("已获授权，等待执行");
  const output = parsedToolOutput(data.result);
  if (data.name === "bash") {
    if (output?.termination === "timed_out") return tr("命令超时，结果待核实");
    if (output?.termination === "cancelled") return tr("命令已取消，结果待核实");
    if (output?.termination === "start_failed") return tr("命令未启动");
    if (typeof output?.signal === "string") return tr("命令终止信号 {{v0}}", { v0: output.signal });
  }
  const failed =
    ["failed", "error"].includes(status) || (isRecord(data.result) && data.result.isError === true);
  if (failed) return tr("失败");
  if (data.name === "wait_for_message" && ["complete", "succeeded"].includes(status))
    return tr("已让出执行，等待新消息");
  if (data.name === "review_access_request" && ["complete", "succeeded"].includes(status)) {
    if (output?.status === "pending")
      return isRecord(data.args) && data.args.decision === "escalate"
        ? tr("已转交 · 仍待审批")
        : tr("仍待审批");
    if (typeof output?.status === "string") return approvalStatusLabel(output.status);
  }
  if (data.name === "rg" && output?.truncated === true) return tr("搜索未完整");
  if (data.name === "rg" && Array.isArray(output?.matches) && output.matches.length === 0)
    return tr("无匹配");
  if (data.name === "bash" && typeof output?.exitCode === "number" && output.exitCode !== 0)
    return tr("命令退出码 {{v0}}", { v0: output.exitCode });
  return toolStatusLabel(
    status === "succeeded" ? "complete" : status === "failed" ? "error" : status,
  );
}

export function parsedToolOutput(value: unknown): Record<string, unknown> | undefined {
  try {
    const text =
      value && typeof value === "object" && "content" in value && Array.isArray(value.content)
        ? value.content
            .filter(
              (part) => isRecord(part) && part.type === "text" && typeof part.text === "string",
            )
            .map((part) => part.text)
            .join("\n")
        : toolResultText(value);
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function readableToolOutput(data: Record<string, unknown>) {
  const output = parsedToolOutput(data.result);
  if (data.name === "bash" && typeof output?.output === "string") return output.output;
  if (output) {
    for (const key of ["error", "content", "text", "message", "warning"])
      if (typeof output[key] === "string") return output[key];
    if (isRecord(output.error) && typeof output.error.message === "string")
      return output.error.message;
    return "";
  }
  return toolResultText(data.result);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function approvalStatusLabel(status: string) {
  return ownLabel(
    {
      pending: tr("仍待审批"),
      approved: tr("已批准"),
      satisfied: tr("已由现有授权满足"),
      denied: tr("已拒绝"),
      cancelled: tr("已取消"),
      expired: tr("已过期"),
      invalidated: tr("权限条件已变化"),
    },
    status,
    status,
  );
}

/** Historic tool payloads are data; inherited object keys are never labels. */
export function ownLabel(labels: Record<string, string>, value: unknown, fallback = "") {
  return typeof value === "string" && Object.hasOwn(labels, value) ? labels[value]! : fallback;
}

export function boundedToolText(value: string, limit = 12000) {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}…\n${tr("展示已截断，更多内容见原始结果。")}`;
}

export function toolInputText(data: Record<string, unknown>) {
  const args = data.args as Record<string, unknown> | undefined;
  if (!args || typeof args !== "object") return "";
  return ["command", "pattern", "title", "message", "task"]
    .filter((key) => typeof args[key] === "string")
    .map((key) => String(args[key]))
    .join("\n");
}

/** Bound raw data and omit binary payloads even in the diagnostic disclosure. */
export function toolDiagnosticText(data: unknown) {
  return (
    JSON.stringify(
      data,
      (key, value) =>
        key === "data" && typeof value === "string" && value.length > 2000
          ? `[binary ${value.length} chars]`
          : typeof value === "string" && value.length > 16000
            ? `${value.slice(0, 16000)}…`
            : value,
      2,
    )?.slice(0, 48000) ?? ""
  );
}
