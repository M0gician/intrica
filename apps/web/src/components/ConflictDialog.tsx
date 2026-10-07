import { useState } from "react";
import { tr, useTranslation } from "../i18n";
import type { ConflictDialogState } from "../state/types";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
export type ConflictDialogProps = {
  dialog: ConflictDialogState;
  onRetry: (operationId: string) => void;
  onDismiss: () => void;
};
export function ConflictDialog(props: ConflictDialogProps) {
  useTranslation();

  const [showDetails, setShowDetails] = useState(false);
  const title = props.dialog.context === "undo" ? tr("撤销冲突") : tr("接受冲突");
  return (
    <Dialog className="conflict-dialog" role="alertdialog" label={title} onClose={props.onDismiss}>
      <h2>{title}</h2>
      <p>{props.dialog.message}</p>
      {showDetails && props.dialog.details.length > 0 && (
        <ul>
          {props.dialog.details.map((detail) => (
            <li key={`${detail.kind}-${detail.id}`}>
              {detail.id}：{detail.reason}
            </li>
          ))}
        </ul>
      )}
      <div className="dialog-actions">
        {props.dialog.details.length > 0 && (
          <Button onClick={() => setShowDetails((current) => !current)}>{tr("查看依赖")}</Button>
        )}
        {props.dialog.context === "accept" && props.dialog.operationId !== null && (
          <Button
            onClick={() => {
              props.onRetry(props.dialog.operationId as string);
              props.onDismiss();
            }}
          >
            {tr("重试")}
          </Button>
        )}
        <Button onClick={props.onDismiss}>
          {props.dialog.context === "undo" ? tr("取消撤销") : tr("关闭")}
        </Button>
      </div>
    </Dialog>
  );
}
