import { tr, useTranslation } from "../i18n";
import type { OperationIntent } from "../state/types";
import { Button } from "../ui/button";
import { OPERATION_LABELS, placementText } from "../utils/labels";
import { ModelLabel } from "./ModelPicker";
export type ConfirmStripProps = {
  intent: OperationIntent;
  onBack: () => void;
  onStart: () => void;
  onOpenFullContext: () => void;
};
/** 生成前简短确认区（规范 §7）：默认选项即可生成，完整上下文另行进入。 */
export function ConfirmStrip(props: ConfirmStripProps) {
  useTranslation();

  const { intent } = props;
  const label = OPERATION_LABELS[intent.type];
  const count = intent.selection.length;
  return (
    // biome-ignore lint/a11y/useSemanticElements: 确认分组无语义等价元素
    <div className="confirm-strip" role="group" aria-label={tr("{{v0}}确认", { v0: label })}>
      <p className="confirm-strip-title">
        {tr("{{v1}}这 {{v0}} 项内容", { v0: count, v1: label })}
      </p>
      <p>{tr("将使用：当前选中的 {{v0}} 个节点", { v0: count })}</p>
      <p>
        {tr("结果位置：")}
        {placementText(intent)}
      </p>
      <ModelLabel />
      <div className="confirm-strip-actions">
        <Button type="button" onClick={props.onBack}>
          {tr("返回")}
        </Button>
        <Button type="button" variant="primary" onClick={props.onStart}>
          {tr("开始生成")}
        </Button>
        <Button type="button" variant="quiet" onClick={props.onOpenFullContext}>
          {tr("查看完整上下文")}
        </Button>
      </div>
    </div>
  );
}
