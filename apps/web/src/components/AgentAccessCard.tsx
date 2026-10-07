import type { AgentRole, ApprovalDecision, ApprovalRecord } from "@intrica/contracts";
import { date, tr, useTranslation } from "../i18n";
import { Button } from "../ui/button";
import { useExecutionTarget } from "./ExecutionTarget";
import { IconShield } from "./icons";
import "./agent-access-card.css";
export type AccessRecord = ApprovalRecord;
export function AgentAccessCard({
  request: r,
  name,
  busy,
  onDecision,
  onInspectPermissions,
  onSelectNode,
}: {
  request: AccessRecord;
  name: (id: string) => string;
  busy: boolean;
  onDecision: (id: string, decision: ApprovalDecision) => void;
  onInspectPermissions?: () => void;
  onSelectNode?: ((id: string) => void) | undefined;
}) {
  useTranslation();
  const target = useExecutionTarget();
  const label = (id: string) => r.names?.[id] || name(id) || id;
  const pending = r.status === "pending";
  const roleName = (role: AgentRole) =>
    role === "admin" ? tr("管理员") : role === "read" ? tr("只读") : tr("读写");
  const title =
    r.kind === "role"
      ? r.summary.role
        ? tr("申请提权 · {{v0}}", { v0: roleName(r.summary.role) })
        : tr("角色权限申请")
      : r.kind === "path"
        ? tr("连接新路径")
        : r.kind === "resource"
          ? tr("资源授权")
          : r.kind === "agent"
            ? tr("Agent 管理")
            : r.kind === "collaboration"
              ? tr("跨权限协作")
              : tr("服务器操作 · {{v0}}", { v0: r.summary.tool ?? "" });
  const status =
    r.status === "pending"
      ? r.reviewerId
        ? tr("等待管理者 {{v0}}", { v0: label(r.reviewerId) })
        : tr("等待你的决定")
      : ({
          approved: tr("已批准"),
          denied: tr("已拒绝"),
          cancelled: tr("已取消"),
          expired: tr("已过期"),
          invalidated: tr("权限条件已变化"),
        }[r.status] ?? r.status);
  const action = r.action;
  const host = action?.kind === "host" ? action : undefined;
  const cwd = typeof host?.args.cwd === "string" ? host.args.cwd : undefined;
  const path =
    r.summary.path ||
    (action?.kind === "path"
      ? action.path
      : typeof host?.args.path === "string"
        ? host.args.path
        : undefined);
  const resourceIds =
    r.summary.resourceIds ??
    (action?.kind === "collaboration" ? action.resourceIds : undefined) ??
    [];
  const requiredRole =
    action && "requiredRole" in action
      ? action.requiredRole
      : ["host", "path", "resource"].includes(r.kind)
        ? r.summary.role
        : undefined;
  const mode = r.summary.mode ?? (action?.kind === "resource" ? action.mode : undefined);
  const operation =
    action?.kind === "agent"
      ? action.operation
      : r.kind === "agent"
        ? r.summary.operation
        : undefined;
  const operationName = operation
    ? ({
        hire: tr("招募 Agent"),
        configure: tr("修改 Agent 配置"),
        dismiss: tr("解散 Agent"),
        schedule: tr("设置 Agent 调度"),
      }[operation] ?? operation)
    : undefined;
  const hasDecision = !pending && (r.decidedBy || r.decidedAt || r.decisionReason);
  const hasTarget = Boolean(
    path ||
      cwd ||
      operationName ||
      (r.kind === "agent" && r.summary.role) ||
      mode ||
      r.summary.recipients?.length ||
      resourceIds.length ||
      action?.kind === "collaboration" ||
      host,
  );
  return (
    <section
      className="agent-access-card"
      data-access-id={r.id}
      data-status={r.status}
      aria-label={tr("权限申请")}
      tabIndex={-1}
    >
      <details key={r.status} open={pending}>
        <summary className="access-card-summary">
          <strong className="access-summary-title">{title}</strong>
          <span className="access-summary-state">{pending ? tr("等待审批") : status}</span>
        </summary>
        <div className="access-card-body">
          <section className="access-section access-request" aria-label={tr("申请说明")}>
            <h4>{tr("申请说明")}</h4>
            <p className="access-attribution">{tr("申请者：{{v0}}", { v0: label(r.agentId) })}</p>
            {r.reason && <p className="access-request-text">{r.reason}</p>}
          </section>

          {hasTarget && (
            <section className="access-section access-target" aria-label={tr("操作对象")}>
              <h4>{tr("操作对象")}</h4>
              <dl className="access-facts">
                {path && (
                  <div className="access-fact-wide">
                    <dt>{path === cwd ? tr("工作目录") : tr("目标路径")}</dt>
                    <dd>
                      <code className="access-path">{path}</code>
                    </dd>
                  </div>
                )}
                {cwd && cwd !== path && (
                  <div className="access-fact-wide">
                    <dt>{tr("工作目录")}</dt>
                    <dd>
                      <code className="access-path">{cwd}</code>
                    </dd>
                  </div>
                )}
                {operationName && (
                  <div>
                    <dt>{tr("操作")}</dt>
                    <dd>{operationName}</dd>
                  </div>
                )}
                {r.kind === "agent" && r.summary.role && (
                  <div>
                    <dt>{tr("目标 Agent 角色")}</dt>
                    <dd>{roleName(r.summary.role)}</dd>
                  </div>
                )}
                {mode && (
                  <div>
                    <dt>{tr("访问方式")}</dt>
                    <dd>{mode === "write" ? tr("读写") : mode === "read" ? tr("只读") : mode}</dd>
                  </div>
                )}
              </dl>
              {!!r.summary.recipients?.length && (
                <p>{tr("接收者：{{v0}}", { v0: r.summary.recipients.map(label).join(" · ") })}</p>
              )}
              {resourceIds.length > 0 && (
                <div className="access-resources">
                  <h5>{r.kind === "role" ? tr("受角色调整影响的资源") : tr("关联资源")}</h5>
                  <ul>
                    {resourceIds.map((id) => (
                      <li key={id}>
                        {onSelectNode && !r.blockedReason ? (
                          <button
                            type="button"
                            className="access-resource-link"
                            aria-label={tr("定位资源：{{v0}}", { v0: label(id) })}
                            onClick={() => onSelectNode(id)}
                          >
                            {label(id)}
                          </button>
                        ) : (
                          label(id)
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {action?.kind === "collaboration" && (
                <div className="access-payload">
                  <h5>{tr("待发送内容")}</h5>
                  <p className="access-message">{action.message}</p>
                </div>
              )}
              {host && (
                <div className="access-payload">
                  <h5>{tr("待执行操作")}</h5>
                  {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable code must be reachable for keyboard reading. */}
                  <pre className="access-command host-action-preview" tabIndex={0}>
                    {host.args.command ?? host.args.path ?? host.tool}
                  </pre>
                </div>
              )}
            </section>
          )}

          <section
            className="access-section access-impact"
            data-risk={
              Boolean(
                requiredRole ||
                  r.blockedReason ||
                  (action?.kind === "path" && action.directory) ||
                  host?.args.fullHost ||
                  (r.kind === "role" && r.summary.role === "admin"),
              ) || undefined
            }
            aria-label={tr("授权影响")}
          >
            <div className="access-section-heading">
              <h4>{tr("授权影响")}</h4>
              <span className="access-scope">
                {r.scope === "once" ? tr("仅限本次操作") : tr("持续授权")}
              </span>
            </div>
            {r.kind === "role" && r.summary.role && (
              <p>{tr("批准后角色：{{v0}}", { v0: roleName(r.summary.role) })}</p>
            )}
            {requiredRole && <p>{tr("同时调整角色：{{v0}}", { v0: roleName(requiredRole) })}</p>}
            {requiredRole && r.scope === "once" && (
              <p className="access-impact-note">
                {tr("单次限制仅适用于本次操作；角色调整将保留。")}
              </p>
            )}
            {action?.kind === "path" && action.directory && (
              <p>
                {tr(
                  "连接目录同时允许持续执行宿主命令；无法隔离时使用服务器账户权限，工作目录不限制文件访问。",
                )}
              </p>
            )}
            {host?.args.fullHost && <p>{tr("完整宿主执行权限：工作目录不构成文件访问隔离。")}</p>}
            {r.blockedReason && (
              <p className="access-blocked">
                {tr("超出当前审查者的授权范围；请向上一级转交，不要根据缺失的详情猜测操作内容。")}
              </p>
            )}
          </section>

          {pending && (
            <div className="access-decision-area">
              <p className="access-reviewer">{status}</p>
              <p className="access-timing">
                {tr("审批截止时间：{{v0}}", { v0: date(r.expiresAt) })}
              </p>
              {r.reviewDueAt && (
                <p className="access-timing">
                  {tr("管理者未处理时，于 {{v0}} 向上一级转交", { v0: date(r.reviewDueAt) })}
                </p>
              )}
              {r.allowedActions.length > 0 && (
                <fieldset
                  className="candidate-decisions access-decisions"
                  aria-label={tr("审批操作")}
                >
                  {r.allowedActions.map((decision) => (
                    <Button
                      key={decision}
                      type="button"
                      variant={
                        decision === "approve"
                          ? "primary"
                          : decision === "escalate"
                            ? "quiet"
                            : "default"
                      }
                      disabled={busy}
                      onClick={() => onDecision(r.id, decision)}
                    >
                      {decision === "approve"
                        ? r.scope === "once"
                          ? tr("允许一次")
                          : tr("批准授权")
                        : decision === "deny"
                          ? tr("拒绝")
                          : tr("由用户接管")}
                    </Button>
                  ))}
                </fieldset>
              )}
            </div>
          )}

          {hasDecision && (
            <section className="access-section access-resolution" aria-label={tr("处理结果")}>
              <h4>{tr("处理结果")}</h4>
              <div className="access-resolution-meta">
                {r.decidedBy && (
                  <span>
                    {tr("决定人：{{v0}}", {
                      v0: r.decidedBy === "owner" ? tr("用户") : label(r.decidedBy),
                    })}
                  </span>
                )}
                {r.decidedAt && <span>{tr("处理时间：{{v0}}", { v0: date(r.decidedAt) })}</span>}
              </div>
              {r.decisionReason && <p className="access-decision-reason">{r.decisionReason}</p>}
            </section>
          )}

          <details className="access-record-details">
            <summary>{tr("审批记录与技术详情")}</summary>
            <dl className="access-facts">
              <div>
                <dt>{tr("所在服务器")}</dt>
                <dd>{target.name}</dd>
              </div>
              {target.address && (
                <div>
                  <dt>{tr("连接地址")}</dt>
                  <dd>{target.address}</dd>
                </div>
              )}
              <div>
                <dt>{tr("审批编号")}</dt>
                <dd>
                  <code>{r.id}</code>
                </dd>
              </div>
              {r.createdAt && (
                <div>
                  <dt>{tr("申请时间")}</dt>
                  <dd>{date(r.createdAt)}</dd>
                </div>
              )}
              {!pending && (
                <div>
                  <dt>{tr("审批截止时间")}</dt>
                  <dd>{date(r.expiresAt)}</dd>
                </div>
              )}
            </dl>
            {action && (
              <>
                <h5>{tr("操作参数与内部标识")}</h5>
                {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable code must be reachable for keyboard reading. */}
                <pre className="host-action-preview" tabIndex={0}>
                  {JSON.stringify(action, null, 2)}
                </pre>
              </>
            )}
          </details>

          {r.status === "approved" && r.scope === "persistent" && (
            <footer className="access-followup">
              <p>{tr("此处保留审批结果，当前权限可能已变化。")}</p>
              {onInspectPermissions && (
                <Button
                  type="button"
                  variant="quiet"
                  aria-label={tr("查看当前有效权限")}
                  onClick={onInspectPermissions}
                >
                  <IconShield size={14} />
                  {tr("当前权限")}
                </Button>
              )}
            </footer>
          )}
        </div>
      </details>
    </section>
  );
}
