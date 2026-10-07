import type { Operation, OperationType } from "@intrica/contracts";
import { tr } from "../i18n";
/** 界面统一命名（数据/协议概念 → 用户界面名称，规范 §7）。 */
export const OPERATION_LABELS: Record<OperationType, string> = {
  get expand() {
    return tr("扩展");
  },
  get deepen() {
    return tr("深入");
  },
  get compress() {
    return tr("收束");
  },
};
export const STATUS_LABELS: Record<Operation["status"], string> = {
  get queued() {
    return tr("排队中");
  },
  get running() {
    return tr("生成中");
  },
  get candidate() {
    return tr("未提交");
  },
  get committed() {
    return tr("已接受");
  },
  get discarded() {
    return tr("已丢弃");
  },
  get failed() {
    return tr("失败");
  },
  get cancelled() {
    return tr("已取消");
  },
};
/** 确认区“结果位置”文案（按动作与选区数量）。 */
export function placementText(intent: { type: OperationType; selection: string[] }): string {
  switch (intent.type) {
    case "expand":
      return tr("当前层（与选中节点同级）");
    case "deepen":
      return intent.selection.length <= 1 ? tr("当前选中节点内部") : tr("新建结果容器（当前层）");
    case "compress":
      return tr("新建摘要容器，并移入所选节点");
  }
}
