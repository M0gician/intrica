import {
  approvalStatusLabel,
  boundedToolText,
  isRecord,
  ownLabel,
  parsedToolOutput,
  toolLabel,
} from "../features/conversations/tool-display";
import { tr } from "../i18n";

const listLimit = 20;
const kindLabel = (kind: unknown) =>
  ownLabel(
    {
      agent: tr("Agent"),
      text: tr("文本"),
      image: tr("图片"),
      pdf: "PDF",
      group: tr("分组"),
      todo: tr("待办"),
      file: tr("文件"),
      directory: tr("目录"),
    },
    kind,
    tr("节点"),
  );
const requestKind = (kind: unknown) =>
  ownLabel(
    {
      role: tr("角色权限申请"),
      path: tr("连接新路径"),
      resource: tr("资源授权"),
      host: tr("服务器操作"),
      agent: tr("Agent 管理"),
      collaboration: tr("跨权限协作"),
    },
    kind,
    tr("权限申请"),
  );

/** Read-only projections of the actual tool response, never approval controls. */
export function ToolResultSummary({
  data,
  nodeName,
  onSelectNode,
}: {
  data: Record<string, unknown>;
  nodeName?: ((id: string) => string) | undefined;
  onSelectNode?: ((id: string) => void) | undefined;
}) {
  const output = parsedToolOutput(data.result);
  const args = isRecord(data.args) ? data.args : {};
  const failed =
    ["error", "failed"].includes(typeof data.status === "string" ? data.status : "") ||
    (isRecord(data.result) && data.result.isError === true);
  const completed =
    !failed &&
    ["complete", "succeeded"].includes(typeof data.status === "string" ? data.status : "");
  const named = (id: unknown, names?: unknown) => {
    if (typeof id !== "string") return tr("Agent");
    const value = isRecord(names) && typeof names[id] === "string" ? names[id] : nodeName?.(id);
    return typeof value === "string" && value && value !== id ? value : tr("Agent");
  };
  const more = (count: number, next: unknown) => (
    <>
      {count > listLimit && (
        <p className="tool-summary-note">
          {tr("仅展示前 {{count}} 项，完整列表见原始结果。", { count: listLimit })}
        </p>
      )}
      {(typeof next === "number" || (typeof next === "string" && next.length > 0)) && (
        <p className="tool-summary-note">{tr("还有后续结果")}</p>
      )}
    </>
  );
  if (data.name === "review_access_request") {
    const operation = ownLabel(
      {
        approve: tr("批准"),
        deny: tr("拒绝"),
        escalate: tr("转交上级"),
      },
      args.decision,
    );
    return (
      <div className="tool-result-summary">
        <dl className="tool-summary-facts">
          {operation && (
            <div>
              <dt>{tr("提交的决定")}</dt>
              <dd>{operation}</dd>
            </div>
          )}
          {typeof args.reason === "string" && args.reason && (
            <div>
              <dt>{tr("审查备注")}</dt>
              <dd>{boundedToolText(args.reason, 2400)}</dd>
            </div>
          )}
          {args.decision === "deny" &&
            typeof args.messageToRequester === "string" &&
            args.messageToRequester && (
              <div>
                <dt>{tr("给申请者的留言")}</dt>
                <dd>{boundedToolText(args.messageToRequester, 2400)}</dd>
              </div>
            )}
          {completed && typeof output?.status === "string" && (
            <div>
              <dt>{tr("申请状态")}</dt>
              <dd>{approvalStatusLabel(output.status)}</dd>
            </div>
          )}
        </dl>
        {completed && output?.status === "approved" && (
          <p className="tool-summary-note">
            {tr("批准记录不代表操作已执行成功，也不代表权限仍然有效。")}
          </p>
        )}
      </div>
    );
  }
  if (failed || !output) return null;
  if (data.name === "read_canvas" && Array.isArray(output.nodes)) {
    const nodes = output.nodes.filter(isRecord);
    if (nodes.length !== output.nodes.length || nodes.some((node) => typeof node.id !== "string"))
      return <p className="tool-summary-note">{tr("结果格式无法识别，请查看原始结果。")}</p>;
    return (
      <div className="tool-result-summary">
        <h3 className="tool-call-heading">
          {tr("本页 {{count}} 个节点", { count: nodes.length })}
        </h3>
        {typeof args.query === "string" && args.query && (
          <p>{tr("筛选：{{query}}", { query: args.query })}</p>
        )}
        <ul className="tool-summary-list">
          {nodes.slice(0, listLimit).map((node, index) => {
            const id = typeof node.id === "string" ? node.id : undefined;
            const title =
              typeof node.title === "string" && node.title ? node.title : tr("未命名节点");
            return (
              <li key={id ?? index}>
                <div className="tool-summary-row">
                  <span className="tool-summary-kind">{kindLabel(node.kind)}</span>
                  {id && onSelectNode ? (
                    <button
                      type="button"
                      className="tool-node-link"
                      onClick={() => onSelectNode(id)}
                    >
                      {title}
                    </button>
                  ) : (
                    <strong>{title}</strong>
                  )}
                </div>
                {typeof node.excerpt === "string" && node.excerpt && (
                  <p>{boundedToolText(node.excerpt, 300)}</p>
                )}
              </li>
            );
          })}
        </ul>
        {more(nodes.length, output.nextOffset)}
      </div>
    );
  }
  if (data.name === "list_access_requests" && Array.isArray(output.requests)) {
    const requests = output.requests.filter(isRecord);
    if (
      requests.length !== output.requests.length ||
      requests.some((request) => typeof request.id !== "string")
    )
      return <p className="tool-summary-note">{tr("结果格式无法识别，请查看原始结果。")}</p>;
    return (
      <div className="tool-result-summary">
        <h3 className="tool-call-heading">
          {tr("本页 {{count}} 项申请", { count: requests.length })}
        </h3>
        {typeof output.total === "number" && output.total !== requests.length && (
          <p className="tool-summary-note">{tr("共 {{count}} 项申请", { count: output.total })}</p>
        )}
        <ul className="tool-summary-list">
          {requests.slice(0, listLimit).map((request, index) => {
            const summary = isRecord(request.summary) ? request.summary : {};
            const roles = { read: tr("只读"), write: tr("读写"), admin: tr("管理员") };
            const role = ownLabel(roles, summary.role);
            const mode = ownLabel(roles, summary.mode);
            const accessLabel = [
              role ? tr("角色：{{role}}", { role }) : "",
              mode ? tr("访问方式：{{mode}}", { mode }) : "",
            ]
              .filter(Boolean)
              .join(" · ");
            const resources = Array.isArray(summary.resourceIds)
              ? summary.resourceIds
                  .filter((id): id is string => typeof id === "string")
                  .map((id) =>
                    isRecord(request.names) && typeof request.names[id] === "string"
                      ? request.names[id]
                      : nodeName?.(id) !== id
                        ? nodeName?.(id)
                        : undefined,
                  )
                  .filter((name): name is string => Boolean(name))
              : [];
            return (
              <li key={typeof request.id === "string" ? request.id : index}>
                <div className="tool-summary-row">
                  <strong>
                    {named(request.agentId, request.names)} · {requestKind(request.kind)}
                  </strong>
                  {typeof request.status === "string" && (
                    <span className="tool-summary-kind">{approvalStatusLabel(request.status)}</span>
                  )}
                </div>
                {(accessLabel || resources.length > 0 || typeof summary.tool === "string") && (
                  <p>
                    {[
                      accessLabel,
                      typeof summary.tool === "string" ? toolLabel(summary.tool) : undefined,
                      ...resources.slice(0, 4),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
                {typeof summary.path === "string" && (
                  <code>{boundedToolText(summary.path, 1200)}</code>
                )}
                {typeof request.reason === "string" && request.reason && (
                  <p>{boundedToolText(request.reason, 600)}</p>
                )}
                {request.status === "pending" && "reviewerId" in request && (
                  <p className="tool-summary-note">
                    {tr("审查者：{{name}}", {
                      name:
                        request.reviewerId === null
                          ? tr("用户")
                          : named(request.reviewerId, request.names),
                    })}
                  </p>
                )}
                {request.blockedReason === "outside_authority" && (
                  <p className="tool-summary-note">{tr("超出当前审查者的授权范围")}</p>
                )}
              </li>
            );
          })}
        </ul>
        {requests.length === 0 && (
          <p className="tool-summary-note">{tr("此次查询未返回申请；不能据此判断申请已批准。")}</p>
        )}
        {more(requests.length, output.nextCursor)}
      </div>
    );
  }
  if (data.name === "read" && typeof output.content === "string") {
    return (
      <div className="tool-result-summary">
        {typeof output.kind === "string" && (
          <p className="tool-summary-note">{kindLabel(output.kind)}</p>
        )}
        {typeof output.nextCursor === "string" && (
          <p className="tool-summary-note">{tr("还有后续内容，可继续读取。")}</p>
        )}
      </div>
    );
  }
  return null;
}
