import type { AgentConfig } from "@intrica/contracts";
import { type RefObject, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useSessionConnection } from "../api/connection";
import { ComposerPopover } from "../features/conversations/ComposerPopover";
import { tr, useTranslation } from "../i18n";
import { Button } from "../ui/button";
import { EffectivePermissions } from "./EffectivePermissions";
import { IconButton, IconClose, IconPlus, IconShield } from "./icons";

const roles = {
  get read() {
    return [tr("只读"), tr("文件工具只读访问连接资源；连接目录允许执行命令。")] as const;
  },
  get write() {
    return [tr("读写"), tr("连接资源可读写，连接目录内执行命令免重复审批。")] as const;
  },
  get admin() {
    return [
      tr("管理员"),
      tr("管理所属团队及成员角色；完整宿主操作免审批，画布资源和跨团队协作仍按授权范围。"),
    ] as const;
  },
} as const;
export type AgentComposerControlsHandle = { inspectPermissions: () => void };
export function AgentComposerControls({
  config,
  onSave,
  onEditPersona,
  agentId,
  agentName,
  active = true,
  controlsRef,
  onSelectNode,
  onResetContext,
  resetBusy = false,
}: {
  config: AgentConfig;
  agentId: string;
  agentName?: string;
  active?: boolean;
  controlsRef?: RefObject<AgentComposerControlsHandle | null>;
  onSelectNode?: ((id: string) => void) | undefined;
  onSave: (patch: Partial<AgentConfig>) => Promise<boolean>;
  onEditPersona: () => void;
  onResetContext?: () => Promise<boolean>;
  resetBusy?: boolean;
}) {
  useTranslation();

  const { transport } = useSessionConnection();
  const [capabilities, setCapabilities] = useState<{
    commands: Array<{
      name: string;
      path: string;
    }>;
    skills: Array<{
      name: string;
      path: string;
    }>;
  }>();
  const [capabilityError, setCapabilityError] = useState("");
  const loadCapabilities = async () => {
    try {
      const response = await transport.fetch(`/api/v2/canvas-agents/${agentId}/capabilities`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error(tr("工具索引暂不可用"));
      setCapabilities(await response.json());
      setCapabilityError("");
    } catch (e) {
      setCapabilityError((e as Error).message);
    }
  };
  const [open, setOpen] = useState<"permissions" | "capabilities" | null>(null);
  const permissionReturnFocus = useRef<HTMLElement | null>(null);
  useImperativeHandle(
    controlsRef,
    () => ({
      inspectPermissions() {
        if (!active) return;
        permissionReturnFocus.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setOpen("permissions");
      },
    }),
    [active],
  );
  useEffect(() => {
    if (!active) setOpen(null);
  }, [active]);
  return (
    <div className="agent-composer-options">
      <ComposerPopover
        label={tr("Agent 能力与设置")}
        icon={<IconPlus />}
        open={active && open === "capabilities"}
        onOpenChange={(value) => setOpen(value ? "capabilities" : null)}
      >
        <button
          type="button"
          className="agent-persona-link"
          onClick={() => {
            setOpen(null);
            onEditPersona();
          }}
        >
          {tr("性格与职责")}
          <span>{tr("编辑 \u2197")}</span>
        </button>
        {onResetContext && (
          <button
            type="button"
            className="agent-persona-link"
            disabled={resetBusy}
            onClick={() => void onResetContext().then((ok) => ok && setOpen(null))}
          >
            {resetBusy ? tr("正在重置\u2026") : tr("重置上下文")}
          </button>
        )}
        <label className="agent-collaboration-choice">
          <span>
            {tr("持续协作")}
            <small>{tr("资源稳定 10 秒后统一处理")}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-checked={config.enabled}
            aria-label={tr("持续协作")}
            checked={config.enabled}
            onChange={(event) => void onSave({ enabled: event.target.checked })}
          />
        </label>
        <label className="agent-collaboration-choice">
          <span>
            {tr("压缩前保存关键资料")}
            <small>{tr("允许 Agent 将重要会话另存为自己的笔记，不修改已有资料。")}</small>
          </span>
          <input
            type="checkbox"
            aria-label={tr("压缩前保存关键资料")}
            checked={config.saveMemoryBeforeCompaction !== false}
            onChange={(e) => void onSave({ saveMemoryBeforeCompaction: e.target.checked })}
          />
        </label>
        <details
          className="agent-available-tools"
          onToggle={(e) => {
            if (e.currentTarget.open) void loadCapabilities();
          }}
        >
          <summary>{tr("可用工具")}</summary>
          <ul>
            <li>
              <strong>{tr("画布资料")}</strong>
              <span>
                {tr("查询摘要、读取权限内全文")}
                {config.role !== "read" ? tr("、修改内容") : ""}
              </span>
            </li>
            <li>
              <strong>{tr("网页搜索")}</strong>
              <span>{tr("搜索公开网页，返回来源链接")}</span>
            </li>
            <li>
              <strong>{tr("Agent 协作")}</strong>
              <span>{tr("单独发送、向共享资源协作者广播、读取共享会话")}</span>
            </li>
            <li>
              <strong>{tr("访问申请")}</strong>
              <span>
                {tr("申请与查看授权")}
                {config.role === "admin" ? tr("、审查团队角色申请") : ""}
              </span>
            </li>
            <li>
              <strong>{tr("本机文件")}</strong>
              <span>
                {config.role === "read"
                  ? tr("连接路径内可读取；写入需先申请提权。")
                  : tr("连接路径内完整读写；需要其他目录时可申请连接新路径。")}
              </span>
            </li>
            <li>
              <strong>{tr("命令与 MCP")}</strong>
              <span>{tr("连接路径内命令与 MCP 隔离执行。新路径或无法隔离的操作由你批准。")}</span>
            </li>
          </ul>
          {capabilities && (
            <>
              <p>
                {tr("已发现 CLI：")}
                {capabilities.commands.map((c) => c.name).join("、") || tr("暂无")}
              </p>
              <details className="host-skill-list">
                <summary>{tr("已安装 {{v0}} 项技能", { v0: capabilities.skills.length })}</summary>
                <ul>
                  {capabilities.skills.map((c) => (
                    <li key={c.path} title={c.path}>
                      {c.name}
                    </li>
                  ))}
                </ul>
              </details>
              <Button type="button" onClick={() => void loadCapabilities()}>
                {tr("刷新工具索引")}
              </Button>
            </>
          )}
          {capabilityError && <p role="status">{capabilityError}</p>}
        </details>
      </ComposerPopover>
      <ComposerPopover
        label={tr("Agent 访问权限")}
        caption={roles[config.role][0]}
        icon={<IconShield />}
        open={active && open === "permissions"}
        returnFocus={permissionReturnFocus}
        onOpenChange={(value) => {
          if (value) permissionReturnFocus.current = null;
          setOpen(value ? "permissions" : null);
        }}
      >
        <header className="agent-permissions-header">
          <div>
            <strong>{tr("访问权限")}</strong>
            {agentName && <small>{agentName}</small>}
          </div>
          <IconButton label={tr("关闭权限")} onClick={() => setOpen(null)}>
            <IconClose />
          </IconButton>
        </header>
        <details className="agent-permission-edit">
          <summary>{tr("调整角色")}</summary>
          <fieldset className="agent-permission-options">
            <legend>{tr("访问权限")}</legend>
            {Object.entries(roles).map(([value, [label, description]]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="agent-access"
                  aria-label={label}
                  checked={config.role === value}
                  onChange={() =>
                    void onSave({ role: value as AgentConfig["role"] }).then((ok) => {
                      if (ok) setOpen(null);
                    })
                  }
                />
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
              </label>
            ))}
          </fieldset>
        </details>
        <EffectivePermissions
          agentId={agentId}
          onSelectNode={
            onSelectNode
              ? (id) => {
                  setOpen(null);
                  onSelectNode(id);
                }
              : undefined
          }
        />
      </ComposerPopover>
    </div>
  );
}
