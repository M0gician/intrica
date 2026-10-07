import type { EffectiveAgentPermissions } from "@intrica/contracts";
import { useEffect, useState } from "react";
import { useSessionConnection } from "../api/connection";
import { tr, useTranslation } from "../i18n";
import { Button } from "../ui/button";
import { useExecutionTarget } from "./ExecutionTarget";
import { IconButton, IconRefresh, IconServer } from "./icons";
import "./effective-permissions.css";

export function EffectivePermissions({
  agentId,
  onSelectNode,
}: {
  agentId: string;
  onSelectNode?: ((id: string) => void) | undefined;
}) {
  useTranslation();
  const { transport, signal, bindingId } = useSessionConnection();
  const target = useExecutionTarget();
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    bindingId: string;
    agentId: string;
    value?: EffectiveAgentPermissions;
    error?: string;
  } | null>(null);
  const current =
    snapshot?.bindingId === bindingId && snapshot.agentId === agentId ? snapshot : null;
  const value = current?.value;
  const error = current?.error;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh rechecks current grants.
  useEffect(() => {
    const cancel = new AbortController();
    const aborted = AbortSignal.any([signal, cancel.signal]);
    setSnapshot(null);
    void transport
      .request<EffectiveAgentPermissions>(
        `/api/v2/canvas-agents/${encodeURIComponent(agentId)}/permissions`,
        { signal: aborted },
      )
      .then((result) => {
        if (!aborted.aborted) setSnapshot({ bindingId, agentId, value: result });
      })
      .catch((reason) => {
        if (!aborted.aborted) setSnapshot({ bindingId, agentId, error: String(reason) });
      });
    return () => cancel.abort();
  }, [transport, signal, bindingId, agentId, revision]);
  return (
    <section className="effective-permissions" aria-label={tr("当前有效权限")}>
      <div className="permissions-server" title={target.address}>
        <IconServer size={14} />
        <span>{tr("执行服务器：{{v0}}", { v0: target.name })}</span>
      </div>
      <div className="permissions-summary">
        <h3>{tr("当前有效权限")}</h3>
        <IconButton
          label={tr("刷新权限")}
          disabled={!value && !error}
          onClick={() => setRevision((value) => value + 1)}
        >
          <IconRefresh size={14} />
        </IconButton>
      </div>
      {error && <p role="alert">{error}</p>}
      {!value && !error && <p role="status">{tr("读取中…")}</p>}
      {value && (
        <>
          <p className="permissions-role">
            {tr("当前角色：{{v0}}", {
              v0:
                value.role === "admin"
                  ? tr("管理员")
                  : value.role === "write"
                    ? tr("读写")
                    : tr("只读"),
            })}
          </p>
          <h4>{tr("有效资源 {{v0}} 项", { v0: value.totalResources })}</h4>
          {value.totalResources === 0 && (
            <p className="permissions-note">{tr("当前没有资源连接授权。")}</p>
          )}
          <ul>
            {value.resources.map((resource) => (
              <li key={`${resource.nodeId}:${resource.sourceLinkId}`}>
                <div className="permission-resource-heading">
                  <strong>{resource.title}</strong>
                  <span>{resource.mode === "write" ? tr("读写") : tr("只读")}</span>
                </div>
                <div className="permission-resource-actions">
                  {onSelectNode && (
                    <Button type="button" onClick={() => onSelectNode(resource.rootId)}>
                      {tr("定位授权来源")}
                    </Button>
                  )}
                  {resource.delegatedBy && onSelectNode && (
                    <Button type="button" onClick={() => onSelectNode(resource.delegatedBy!)}>
                      {tr("查看授予者")}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {value.totalResources > value.resources.length && (
            <p>
              {tr("仅显示前 {{v0}} 项，请定位具体资源查看连接。", { v0: value.resources.length })}
            </p>
          )}
          <p className="permissions-note">
            {tr(
              "资源连接决定可访问内容；目录授权还包含宿主命令能力。变更授权可能影响依赖它的团队成员。",
            )}
          </p>
        </>
      )}
    </section>
  );
}
