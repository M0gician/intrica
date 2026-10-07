import type {
  CandidateContainerProjection,
  CandidateNodeProjection,
  Operation,
} from "@intrica/contracts";
import { useState } from "react";
import { tr, useTranslation } from "../i18n";
import { Button } from "../ui/button";
import { OPERATION_LABELS, placementText, STATUS_LABELS } from "../utils/labels";
import { IconClose } from "./icons";
import { MarkdownLite } from "./MarkdownLite";
export type ReviewPanelProps = {
  operation: Operation;
  candidates: CandidateNodeProjection[];
  candidateContainer: CandidateContainerProjection | null;
  inputTitles: string[];
  memberTitles: string[];
  onClose: () => void;
  onAcceptAll: (operationId: string) => void;
  onDecideCandidate?: (
    opId: string,
    candidateId: string,
    action: "accept" | "retry",
  ) => Promise<void>;
  onDiscard: (operationId: string) => void;
  onRetry: (operationId: string) => void;
  onUndo: (operationId: string) => void;
  onPreviewInside: (operationId: string) => void;
};
/** 右侧审阅面板（“逐个查看”）：候选只读全文、成员、放置信息与决定按钮（规范 §8）。 */
export function ReviewPanel(props: ReviewPanelProps) {
  useTranslation();

  const { operation } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (id: string, action: "accept" | "retry") => {
    setBusy(id);
    try {
      await props.onDecideCandidate?.(operation.id, id, action);
    } finally {
      setBusy(null);
    }
  };
  const label = OPERATION_LABELS[operation.type];
  const placement = placementText({ type: operation.type, selection: operation.selection });
  const canPreviewInside = operation.type === "deepen";
  return (
    <aside
      className="inspector-panel review-panel"
      aria-label={tr("{{v0}}审阅：{{v1}}", {
        v0: label,
        v1: STATUS_LABELS[operation.status],
      })}
    >
      <div className="panel-header">
        <strong>
          {label} · {STATUS_LABELS[operation.status]}
        </strong>
        <Button type="button" aria-label={tr("关闭审阅面板")} onClick={props.onClose}>
          <IconClose size={14} />
        </Button>
      </div>

      <div className="panel-body">
        <section aria-label={tr("输入")}>
          <h2>{tr("输入")}</h2>
          <p>{props.inputTitles.join("、") || tr("（无）")}</p>
        </section>

        <section aria-label={tr("放置信息")}>
          <h2>{tr("结果位置")}</h2>
          <p>{placement}</p>
        </section>

        {operation.type === "compress" && operation.candidateSummary && (
          <section aria-label={tr("候选摘要")}>
            <h2>{operation.candidateSummary.title}</h2>
            <MarkdownLite text={operation.candidateSummary.summary} />
            <p>
              {tr("将移入成员：")}
              {props.memberTitles.join("、")}
            </p>
          </section>
        )}

        {operation.type !== "compress" && (
          <section aria-label={tr("候选内容")}>
            <h2>
              {tr("候选内容（")}
              {props.candidates.length}）
            </h2>
            {props.candidates.map((candidate) => (
              <article key={candidate.id} className="review-candidate">
                <h4>{candidate.title ?? tr("未命名结果")}</h4>
                {operation.type === "expand" &&
                  operation.status === "candidate" &&
                  props.onDecideCandidate && (
                    <div className="candidate-decisions">
                      <Button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void decide(candidate.id, "accept")}
                      >
                        {tr("接受此项")}
                      </Button>
                      <Button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void decide(candidate.id, "retry")}
                      >
                        {busy === candidate.id ? tr("处理中\u2026") : tr("重试此项")}
                      </Button>
                    </div>
                  )}
                {candidate.text ? <MarkdownLite text={candidate.text} /> : null}
              </article>
            ))}
          </section>
        )}

        {operation.reason ? (
          <p className="review-reason">
            {tr("原因：")}
            {operation.reason}
          </p>
        ) : null}

        <fieldset className="dialog-actions" disabled={busy !== null}>
          {operation.status === "candidate" && (
            <>
              <Button
                type="button"
                variant="primary"
                onClick={() => props.onAcceptAll(operation.id)}
              >
                {tr("接受全部")}
              </Button>
              <Button type="button" onClick={() => props.onDiscard(operation.id)}>
                {tr("丢弃")}
              </Button>
              <Button type="button" onClick={() => props.onRetry(operation.id)}>
                {tr("重试")}
              </Button>
              {canPreviewInside && (
                <Button type="button" onClick={() => props.onPreviewInside(operation.id)}>
                  {tr("查看候选内部")}
                </Button>
              )}
            </>
          )}
          {operation.status === "committed" && operation.undoToken && !operation.undone && (
            <Button type="button" onClick={() => props.onUndo(operation.id)}>
              {tr("撤销")}
            </Button>
          )}
          {operation.status === "failed" && (
            <Button type="button" onClick={() => props.onRetry(operation.id)}>
              {tr("重试")}
            </Button>
          )}
        </fieldset>
      </div>
    </aside>
  );
}
