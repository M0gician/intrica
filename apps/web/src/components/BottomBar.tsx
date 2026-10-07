import type { Node } from "@intrica/contracts";
import { generationPdfNodeIds } from "@intrica/contracts";
import { tr, useTranslation } from "../i18n";
import { Button } from "../ui/button";
import { commonScopeId, findAncestorConflict } from "../utils/graph";
import {
  IconButton,
  IconCompress,
  IconCopy,
  IconDeepen,
  IconDelete,
  IconExpand,
  IconInspector,
  IconLink,
  IconMore,
} from "./icons";
export type ActionId = "expand" | "deepen" | "compress" | "link";
export type ActionAvailability = {
  id: ActionId;
  label: string;
  /** 落点说明，随选区数量更新。 */
  hint: string;
  enabled: boolean;
  disabledReason: string | null;
};
export type AvailabilityResult = {
  blockedPdfNodeIds?: string[];
  actions: ActionAvailability[];
  scopeId: string | null;
  selectionCount: number;
};
/** 底栏动作可用性矩阵（PRD §3 操作放置规则 + 选区约束）。 */
export function computeActionAvailability(
  nodes: ReadonlyMap<string, Node>,
  selection: ReadonlySet<string>,
): AvailabilityResult {
  const selectionCount = selection.size;
  const scopeId = commonScopeId(nodes, selection);
  const ancestorConflict = findAncestorConflict(nodes, selection);
  const mixedScope = selectionCount > 0 && scopeId === null;
  const blockedPdfNodeIds = generationPdfNodeIds(
    [...selection, ...(scopeId ? [scopeId] : [])]
      .map((id) => nodes.get(id))
      .filter((node): node is Node => Boolean(node)),
  );
  const structuralReason = ancestorConflict
    ? tr("选区不能同时包含父节点及其后代，请改为只选择父节点或只选择后代")
    : mixedScope
      ? tr("请选择同一层级")
      : null;
  const make = (
    id: ActionId,
    label: string,
    hint: string,
    baseEnabled: boolean,
    baseReason: string | null,
  ): ActionAvailability => {
    const pdfReason =
      id !== "link" && blockedPdfNodeIds.length
        ? tr("PDF 需由 Agent 按页阅读，暂不支持画布生成")
        : null;
    const enabled = baseEnabled && structuralReason === null && pdfReason === null;
    return {
      id,
      label,
      hint,
      enabled,
      disabledReason: enabled ? null : (structuralReason ?? pdfReason ?? baseReason),
    };
  };
  return {
    scopeId,
    selectionCount,
    blockedPdfNodeIds,
    actions: [
      make(
        "expand",
        tr("扩展"),
        tr("当前层生成平行节点"),
        selectionCount >= 1,
        tr("至少选择一个节点"),
      ),
      make(
        "deepen",
        tr("深入"),
        selectionCount <= 1 ? tr("在选中节点内部生成") : tr("新建结果容器并在其中生成"),
        selectionCount >= 1,
        tr("至少选择一个节点"),
      ),
      make(
        "compress",
        tr("收束"),
        tr("创建摘要容器并移入所选节点"),
        selectionCount >= 2,
        tr("至少选择两个节点才能收束"),
      ),
      make(
        "link",
        tr("连接"),
        selectionCount === 2 ? tr("连接两个选中节点") : tr("选择目标，连接整组选区"),
        selectionCount >= 1,
        tr("先选择节点"),
      ),
    ],
  };
}
const ACTION_ICONS: Record<ActionId, () => React.ReactNode> = {
  expand: () => <IconExpand size={16} />,
  deepen: () => <IconDeepen size={16} />,
  compress: () => <IconCompress size={16} />,
  link: () => <IconLink size={16} />,
};
export type BottomBarProps = {
  availability: AvailabilityResult;
  moreOpen: boolean;
  canInspect: boolean;
  onAction: (id: ActionId) => void;
  onToggleMore: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onInspect: () => void;
  agentRunBusy?: boolean;
  agentRunState?: "idle" | "working" | undefined;
  onAgentRun?: ((action: "start" | "stop") => void) | undefined;
  onReadPdf?: ((nodeIds: string[]) => void) | undefined;
};
/** 底栏：选中后固定显示，不依赖鼠标靠近（规范 §7）。 */
export function BottomBar(props: BottomBarProps) {
  useTranslation();

  const count = props.availability.selectionCount;
  if (count === 0) return null;
  return (
    <div className="bottom-controls" onPointerDown={(event) => event.stopPropagation()}>
      {props.agentRunState && props.onAgentRun && (
        <button
          type="button"
          disabled={props.agentRunBusy}
          className={`batch-agent-button ${props.agentRunState === "working" ? "is-stop" : "is-start"}`}
          aria-label={
            props.agentRunState === "working"
              ? tr("停止选中 Agent 及其团队")
              : tr("启动选中 Agent 及其团队")
          }
          title={
            props.agentRunState === "working"
              ? tr("停止选中 Agent 及其团队")
              : tr("启动选中 Agent 及其团队")
          }
          onClick={() => props.onAgentRun!(props.agentRunState === "working" ? "stop" : "start")}
        >
          <span aria-hidden="true">{props.agentRunState === "working" ? "■" : "▶"}</span>
        </button>
      )}
      <div className="bottom-bar" role="toolbar" aria-label={tr("选中操作栏")}>
        <span className="bottom-bar-count">{tr("已选择 {{v0}} 项", { v0: count })}</span>
        <div className="bottom-bar-actions">
          {!!props.availability.blockedPdfNodeIds?.length && props.onReadPdf && (
            <Button
              variant="default"
              type="button"
              className="pdf-read-action"
              onClick={() => props.onReadPdf!(props.availability.blockedPdfNodeIds!)}
            >
              {tr("交给 Agent 阅读 PDF")}
            </Button>
          )}
          {props.availability.actions.map((action) => (
            <span key={action.id} className="bottom-bar-action">
              <IconButton
                label={
                  action.enabled
                    ? `${action.label}：${action.hint}`
                    : tr("{{v0}}（不可用：{{v1}}）", {
                        v0: action.label,
                        v1: action.disabledReason ?? "",
                      })
                }
                caption={action.enabled ? action.label : (action.disabledReason ?? action.label)}
                disabled={!action.enabled}
                onClick={() => props.onAction(action.id)}
              >
                {ACTION_ICONS[action.id]()}
              </IconButton>
            </span>
          ))}
          <IconButton
            label={tr("更多")}
            caption={tr("更多")}
            active={props.moreOpen}
            onClick={props.onToggleMore}
          >
            <IconMore size={16} />
          </IconButton>
        </div>
        {props.moreOpen && (
          <div className="more-menu ui-menu" role="menu" aria-label={tr("更多操作")}>
            <Button variant="menu" type="button" role="menuitem" onClick={props.onDelete}>
              <IconDelete size={14} />
              {tr("删除")}
            </Button>
            <Button variant="menu" type="button" role="menuitem" onClick={props.onCopy}>
              <IconCopy size={14} />
              {tr("复制")}
            </Button>
            <Button
              variant="menu"
              type="button"
              role="menuitem"
              disabled={!props.canInspect}
              onClick={props.onInspect}
            >
              <IconInspector size={14} />
              {tr("查看详情")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
