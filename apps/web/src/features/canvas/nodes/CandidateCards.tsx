import type { CandidateContainerProjection, CandidateNodeProjection } from "@intrica/contracts";
import { IconGroup, IconText } from "../../../components/icons";
import { tr, useTranslation } from "../../../i18n";
export function CandidateCard(props: {
  candidate: CandidateNodeProjection;
  status: "running" | "candidate";
}) {
  useTranslation();

  const { candidate } = props;
  const statusLabel = props.status === "candidate" ? tr("未提交") : tr("生成中");
  return (
    <article
      className={`node-card candidate${props.status === "running" ? " candidate-outline" : ""}`}
      style={{
        left: candidate.position.x,
        top: candidate.position.y,
        width: candidate.position.width,
        height: candidate.position.height,
      }}
      data-node-id={candidate.id}
      data-candidate="true"
      aria-label={tr("候选节点：{{v0}}，{{v1}}", {
        v0: candidate.title ?? tr("未命名结果"),
        v1: statusLabel,
      })}
    >
      <header className="node-card-header">
        <span className="node-type-icon" aria-hidden="true">
          <IconText size={14} />
        </span>
        <span className="node-card-title">{candidate.title ?? tr("未命名结果")}</span>
        <span className="tier-badge tier-badge-candidate">{statusLabel}</span>
      </header>
      <section className="node-card-body">
        <p className="node-card-summary">{candidate.text ?? ""}</p>
      </section>
    </article>
  );
}
export function CandidateContainerCard(props: {
  container: CandidateContainerProjection;
  childPreview?: string[];
  onPreviewInside: (operationId: string) => void;
}) {
  useTranslation();

  const { container } = props;
  return (
    <article
      className="node-card candidate candidate-container"
      style={{
        left: container.position.x,
        top: container.position.y,
        width: container.position.width,
        height: container.position.height,
      }}
      data-node-id={container.id}
      data-candidate="true"
      aria-label={tr("候选结果容器：{{v0}}，未提交", {
        v0: container.title ?? tr("深化结果"),
      })}
    >
      <header className="node-card-header">
        <span className="node-type-icon" aria-hidden="true">
          <IconGroup size={14} />
        </span>
        <span className="node-card-title">{container.title ?? tr("深化结果")}</span>
        <span className="tier-badge tier-badge-candidate">{tr("未提交")}</span>
      </header>
      <section className="node-card-body">
        {props.childPreview && props.childPreview.length > 0 ? (
          <ul className="node-card-child-preview" aria-label={tr("候选子项预览")}>
            {props.childPreview.map((title, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 静态摘要允许重名
              <li key={`${index}-${title}`}>{title}</li>
            ))}
          </ul>
        ) : null}
        <div className="node-card-folder">
          {tr("子项 {{v0}}", { v0: container.childIds.length })}
        </div>
        <button
          type="button"
          className="node-card-more"
          onClick={() => props.onPreviewInside(container.operationId)}
        >
          {tr("查看候选内部")}
        </button>
      </section>
    </article>
  );
}
