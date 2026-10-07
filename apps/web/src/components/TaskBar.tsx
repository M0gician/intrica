import type { Operation } from "@intrica/contracts";
import { useEffect, useState } from "react";
import { tr, useTranslation } from "../i18n";
import { Button } from "../ui/button";
import { OPERATION_LABELS, STATUS_LABELS } from "../utils/labels";
export type TaskChipData = {
  operation: Operation;
  queuePosition: number | null;
  /** 生成中已到达的语义段数。 */
  segmentCount: number;
  candidateCount: number;
};
export type TaskBarProps = {
  chips: TaskChipData[];
  onCancel: (operationId: string) => void;
  onAcceptAll: (operationId: string) => void;
  onReviewOne: (operationId: string) => void;
  onDiscard: (operationId: string) => void;
  onRetry: (operationId: string) => void;
  onShowReason: (operationId: string) => void;
  onUndo: (operationId: string) => void;
  onClose: (operationId: string) => void;
};
/** 底部任务状态条：每个进行中的生成任务一个 chip（规范 §8）。 */
export function TaskBar(props: TaskBarProps) {
  useTranslation();

  const hasActive = props.chips.some(
    ({ operation }) =>
      operation.status === "queued" ||
      operation.status === "running" ||
      operation.status === "candidate" ||
      operation.status === "failed",
  );
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (hasActive) {
      setCollapsed(false);
      return;
    }
    const timer = window.setTimeout(() => setCollapsed(true), 1400);
    return () => window.clearTimeout(timer);
  }, [hasActive]);
  if (props.chips.length === 0) return null;
  if (collapsed) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: 任务状态条不是表单字段集
      <div className="task-bar task-bar-collapsed" role="group" aria-label={tr("生成任务状态条")}>
        <button
          type="button"
          className="task-bar-toggle"
          onClick={() => setCollapsed(false)}
          aria-label={tr("展开任务历史")}
        >
          {tr("任务")}
          {props.chips.length}
        </button>
      </div>
    );
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: 任务状态条无语义等价元素
    <div className="task-bar" role="group" aria-label={tr("生成任务状态条")}>
      {!hasActive && (
        <button
          type="button"
          className="task-bar-toggle"
          onClick={() => setCollapsed(true)}
          aria-label={tr("折叠任务历史")}
        >
          {tr("收起")}
        </button>
      )}
      {props.chips.map((chip) => {
        const { operation } = chip;
        const label = OPERATION_LABELS[operation.type];
        return (
          // biome-ignore lint/a11y/useSemanticElements: 任务 chip 分组无语义等价元素
          <div
            key={operation.id}
            className={`task-chip task-chip-${operation.status}`}
            role="group"
            aria-label={tr("{{v0}}任务：{{v1}}", {
              v0: label,
              v1: STATUS_LABELS[operation.status],
            })}
          >
            <span className="task-chip-label">
              {label} · {STATUS_LABELS[operation.status]}
            </span>

            {operation.status === "queued" && (
              <>
                {chip.queuePosition !== null && (
                  <span className="task-chip-info">
                    {tr("第 {{v0}} 位", { v0: chip.queuePosition })}
                  </span>
                )}
                <Button type="button" onClick={() => props.onCancel(operation.id)}>
                  {tr("取消排队")}
                </Button>
              </>
            )}

            {operation.status === "running" && (
              <>
                <span className="task-chip-info">
                  {tr("已到达 {{v0}} 段", { v0: chip.segmentCount })}
                </span>
                <Button type="button" onClick={() => props.onCancel(operation.id)}>
                  {tr("取消")}
                </Button>
              </>
            )}

            {operation.status === "candidate" && (
              <>
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => props.onAcceptAll(operation.id)}
                >
                  {tr("接受全部")}
                </Button>
                <Button type="button" onClick={() => props.onReviewOne(operation.id)}>
                  {tr("逐个查看")}
                </Button>
                <Button type="button" onClick={() => props.onDiscard(operation.id)}>
                  {tr("丢弃")}
                </Button>
              </>
            )}

            {operation.status === "committed" && (
              <Button type="button" onClick={() => props.onUndo(operation.id)}>
                {tr("撤销")}
              </Button>
            )}

            {operation.status === "failed" && (
              <>
                <Button type="button" onClick={() => props.onRetry(operation.id)}>
                  {tr("重试")}
                </Button>
                <Button type="button" onClick={() => props.onShowReason(operation.id)}>
                  {tr("查看原因")}
                </Button>
              </>
            )}

            {(operation.status === "discarded" || operation.status === "cancelled") && (
              <Button type="button" onClick={() => props.onClose(operation.id)}>
                {tr("关闭")}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
