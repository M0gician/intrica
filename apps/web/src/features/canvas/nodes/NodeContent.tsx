import { useState } from "react";
import { useSessionConnection } from "../../../api/connection";
import { IconGroup, IconImage } from "../../../components/icons";
import { TodoList } from "../../../components/TodoList";
import { WebPreview } from "../../../components/WebPreview";
import { WorkspaceImagePreview } from "../../../components/WorkspaceImagePreview";
import { tr } from "../../../i18n";
import type { NodePresentation } from "../../../utils/resource-view";
import { AgentNodeContent } from "./AgentNodeContent";
import type { NodeCardProps } from "./types";

function AssetContent({
  props,
  title,
  pdf,
}: {
  props: NodeCardProps;
  title: string;
  pdf: boolean;
}) {
  const { assetUrl } = useSessionConnection();
  const { node } = props;
  const [failed, setFailed] = useState<string>();
  if (node.assetId && failed !== node.assetId)
    return (
      <img
        className="node-card-image"
        src={assetUrl(`/api/v2/assets/${encodeURIComponent(node.assetId)}?variant=thumb`)}
        alt={node.alt ?? title}
        draggable={false}
        onError={() => setFailed(node.assetId)}
      />
    );
  return pdf ? (
    <div className="pdf-card-placeholder">
      <strong>PDF</strong>
      <small>{tr("双击阅读 PDF")}</small>
    </div>
  ) : (
    <div className="image-unavailable">
      <IconImage size={28} />
      <span>{tr("图片暂不可用")}</span>
    </div>
  );
}

function TextContent({ props }: { props: NodeCardProps }) {
  const { node } = props;
  const summary = node.kind === "group" ? (node.summary ?? "") : (node.text ?? "");
  const overflow = summary.length > 140 || summary.split("\n").length > 5;
  return (
    <>
      {props.childPreview?.length ? (
        <ul className="node-card-child-preview" aria-label={tr("子项预览")}>
          {props.childPreview.map((title, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Preview titles can repeat.
            <li key={`${index}-${title}`}>{title}</li>
          ))}
        </ul>
      ) : summary ? (
        <p className="node-card-summary">{summary}</p>
      ) : null}
      {overflow && (
        <button type="button" className="node-card-more" onClick={() => props.onInspect(node.id)}>
          {tr("查看详情")}
        </button>
      )}
    </>
  );
}

export function NodeContent({
  props,
  presentation,
  title,
}: {
  props: NodeCardProps;
  presentation: NodePresentation;
  title: string;
}) {
  const { node } = props;
  switch (presentation.type) {
    case "directory":
      return (
        <div className="directory-card-content">
          <IconGroup size={36} />
          <span className="directory-kind-label">{tr("本机目录")}</span>
          <p title={presentation.path}>{presentation.path}</p>
          <small className="resource-open-hint">{tr("双击浏览文件")}</small>
        </div>
      );
    case "web":
      return (
        <div className="bookmark-card-content">
          <WebPreview url={presentation.bookmark.url} title={presentation.bookmark.title} />
          <small className="bookmark-host">{presentation.bookmark.host}</small>
        </div>
      );
    case "path-image":
      return (
        <WorkspaceImagePreview
          path={presentation.path}
          alt={node.title ?? presentation.path}
          className="node-card-image"
          preview
        />
      );
    case "image":
    case "pdf":
    case "path-pdf":
      return <AssetContent props={props} title={title} pdf={presentation.type !== "image"} />;
    case "agent":
      return <AgentNodeContent props={props} title={title} />;
    case "todo":
      return (
        <div className="todo-card-content">
          <TodoList
            text={node.text ?? ""}
            completed={node.todo?.completed}
            onSave={
              props.onSaveTodo
                ? (text, completed) => props.onSaveTodo!(node.id, text, completed)
                : undefined
            }
          />
        </div>
      );
    case "text":
    case "group":
    case "file":
      return <TextContent props={props} />;
  }
}
