import type { Edge, Node, Operation } from "@intrica/contracts";
import { DownloadStatus, useFileDownload } from "../features/files/download";
import { FileReferenceView } from "../features/files/FileReferenceView";
import { BookmarkAddress, EditableField } from "../features/inspector/fields";
import { InspectorMetadata } from "../features/inspector/InspectorMetadata";
import { tr, useTranslation } from "../i18n";
import { Button } from "../ui/button";
import { nodePresentation } from "../utils/resource-view";
import { AgentNodePanel } from "./AgentNodePanel";
import { DocumentEditor } from "./DocumentEditor";
import { ImagePreview } from "./ImagePreview";
import { IconBrowser, IconEnter, IconGroup } from "./icons";
import { PdfPreview } from "./PdfPreview";
export type InspectorPanelProps = {
  active?: boolean;
  focusRequest?:
    | {
        id: string;
        nonce: number;
      }
    | undefined;
  node: Node;
  nodes: ReadonlyMap<string, Node>;
  edges: ReadonlyMap<string, Edge>;
  operations: ReadonlyMap<string, Operation>;
  onClose: () => void;
  onActivateNode?: ((id: string) => void) | undefined;
  onDeleteEdge?: (edge: Edge) => void;
  onOpenResource?: (resource: import("@intrica/contracts").LocalResource) => void;
  onSelectNode: (nodeId: string) => void;
  onOpenOverlay: (nodeId: string) => void;
  onSave: (
    nodeId: string,
    patch: {
      title?: string;
      text?: string;
      alt?: string;
      summary?: string;
      todo?: import("@intrica/contracts").TodoConfig;
      agent?: import("@intrica/contracts").AgentConfig;
    },
    expectedRevision?: number,
  ) => Promise<Node | null>;
};
export function InspectorPanel(props: InspectorPanelProps) {
  useTranslation();

  const { node } = props;
  const presentation = nodePresentation(node);
  const download = useFileDownload();
  const downloadPdf = () => {
    const name = node.title || "document.pdf";
    if (node.resource?.type === "file") void download.start({ path: node.resource.path, name });
    else if (node.assetId)
      void download.start({
        assetId: node.assetId,
        name: /\.pdf$/i.test(name) ? name : `${name}.pdf`,
      });
  };
  if (node.contentLoaded === false && node.kind !== "agent")
    return (
      <div className="panel-body" role="status">
        {tr("正在读取正文\u2026")}
      </div>
    );
  const children = node.childOrder
    .map((id) => props.nodes.get(id))
    .filter((value): value is Node => Boolean(value));
  const metadata = <InspectorMetadata {...props} />;
  if (node.resource?.type === "file")
    return (
      <div className="panel-body file-inspector">
        <section className="detail-title" aria-label={tr("名称")}>
          <EditableField
            value={node.title ?? ""}
            ariaLabel={tr("节点标题")}
            onCommit={(title) => void props.onSave(node.id, { title })}
          />
        </section>
        {node.resource.snapshot && <p>{tr("发布时的文件")}</p>}
        <FileReferenceView origin={{ kind: "node", id: node.id }} embedded />
        {node.kind === "image" && (
          <EditableField
            value={node.alt ?? ""}
            ariaLabel={tr("图片说明")}
            onCommit={(alt) => void props.onSave(node.id, { alt })}
          />
        )}
        {node.text && node.text !== node.resource.path && (
          <DocumentEditor
            id={node.id}
            value={node.text}
            version={node.revision}
            fileOrigin={{ kind: "node", id: node.id }}
            onSave={(text, version) => props.onSave(node.id, { text }, version)}
          />
        )}
        <Button onClick={() => props.onOpenResource?.(node.resource!)}>
          {tr("查看当前源文件")}
        </Button>
        {metadata}
      </div>
    );
  if (node.kind === "agent" && node.agent)
    return (
      <div className="panel-body agent-inspector">
        <AgentNodePanel
          active={props.active ?? true}
          key={node.id}
          node={node}
          focusRequest={props.focusRequest}
          onSelectNode={props.onSelectNode}
          onRename={async (title) => Boolean(await props.onSave(node.id, { title }))}
          onOpenFile={(path) => props.onOpenResource?.({ type: "file", path })}
          linkedCount={
            [...props.edges.values()].filter(
              (e) => e.confirmed && (e.from === node.id || e.to === node.id),
            ).length
          }
          nodes={props.nodes}
          onSave={async (agent) => Boolean(await props.onSave(node.id, { agent }))}
          context={
            <>
              {children.length > 0 && (
                <Button
                  type="button"
                  className="detail-enter"
                  onClick={() => props.onOpenOverlay(node.id)}
                >
                  <IconEnter size={14} />
                  {tr("进入内部")}
                </Button>
              )}
              {metadata}
            </>
          }
        />
      </div>
    );
  const bookmark = presentation.type === "web" ? presentation.bookmark : null;
  if (presentation.type === "directory" || bookmark)
    return (
      <div className="panel-body resource-overview">
        <div className="resource-overview-mark">
          {bookmark ? <IconBrowser size={36} /> : <IconGroup size={44} />}
        </div>
        <section className="detail-title" aria-label={tr("名称")}>
          <span className="sr-only">{tr("名称")}</span>
          <EditableField
            value={node.title ?? bookmark?.title ?? ""}
            ariaLabel={tr("节点标题")}
            onCommit={(title) => void props.onSave(node.id, { title })}
          />
        </section>
        {bookmark ? (
          <BookmarkAddress
            key={node.id}
            url={bookmark.url}
            onSave={async (text) =>
              Boolean(
                await props.onSave(
                  node.id,
                  { text, ...(bookmark.title !== bookmark.host ? { title: bookmark.title } : {}) },
                  node.revision,
                ),
              )
            }
          />
        ) : (
          <p className="resource-overview-location">{node.resource?.path}</p>
        )}
        <Button
          type="button"
          className="resource-primary-action"
          onClick={() =>
            props.onActivateNode
              ? props.onActivateNode(node.id)
              : node.resource
                ? props.onOpenResource?.(node.resource)
                : undefined
          }
        >
          {bookmark ? tr("打开网页 \u2197") : tr("浏览目录")}
        </Button>
        {metadata}
      </div>
    );
  if (presentation.type === "pdf" || presentation.type === "path-pdf")
    return (
      <div className="panel-body pdf-inspector">
        <section className="detail-title" aria-label={tr("PDF 名称")}>
          <EditableField
            value={node.title ?? ""}
            ariaLabel={tr("节点标题")}
            placeholder={tr("PDF 名称")}
            onCommit={(title) => void props.onSave(node.id, { title })}
          />
        </section>
        {node.kind === "pdf" ? (
          <PdfPreview
            key={`${node.id}:${node.assetVersion ?? node.revision}`}
            nodeId={node.id}
            title={node.title ?? "PDF"}
            onDownload={downloadPdf}
            downloadBusy={download.busy}
          />
        ) : (
          <PdfPreview
            path={node.resource!.path}
            title={node.title ?? "PDF"}
            onDownload={downloadPdf}
            downloadBusy={download.busy}
          />
        )}
        {node.resource && <p className="resource-overview-location">{node.resource.path}</p>}
        <DownloadStatus download={download} />
        {metadata}
      </div>
    );
  if (node.kind === "image")
    return (
      <div className="panel-body image-inspector">
        <FileReferenceView origin={{ kind: "node", id: node.id }} label={tr("预览与下载原文件")} />
        <section className="detail-title" aria-label={tr("图片名称")}>
          <span className="sr-only">{tr("图片名称")}</span>
          <EditableField
            value={node.title ?? ""}
            ariaLabel={tr("节点标题")}
            placeholder={tr("图片名称")}
            onCommit={(title) => void props.onSave(node.id, { title })}
          />
        </section>
        {
          <ImagePreview
            key={`${node.assetId}:${node.assetVersion}`}
            assetId={node.assetId}
            alt={node.alt ?? node.title ?? tr("图片")}
          />
        }
        <details className="detail-meta">
          <summary>
            {tr("图片说明")}
            {node.resource ? tr("与来源") : ""}
          </summary>
          <EditableField
            value={node.alt ?? ""}
            ariaLabel={tr("替代文本")}
            placeholder={tr("描述图片内容\u2026")}
            onCommit={(alt) => void props.onSave(node.id, { alt })}
          />
          {node.resource && (
            <Button
              type="button"
              className="image-source"
              onClick={() => props.onOpenResource?.(node.resource!)}
            >
              {node.resource.path} ↗
            </Button>
          )}
        </details>
        {metadata}
      </div>
    );
  if (node.kind === "todo")
    return (
      <div className="panel-body todo-inspector">
        <section className="detail-title" aria-label={tr("待办标题")}>
          <EditableField
            value={node.title ?? ""}
            ariaLabel={tr("待办标题")}
            placeholder={tr("待办事项")}
            onCommit={(title) => void props.onSave(node.id, { title })}
          />
        </section>
        <DocumentEditor
          fileOrigin={{ kind: "node", id: node.id }}
          taskList
          id={`${node.id}-todo`}
          value={node.text ?? ""}
          version={node.revision}
          onSave={(text, version) => props.onSave(node.id, { text }, version)}
        />
        {metadata}
      </div>
    );
  return (
    <div className="panel-body">
      {node.kind !== "agent" && (
        <section aria-label={tr("标题")} className="detail-title">
          <h2 className="sr-only">{tr("标题")}</h2>
          <EditableField
            value={node.title ?? ""}
            ariaLabel={tr("节点标题")}
            placeholder={tr("未命名")}
            onCommit={(value) => void props.onSave(node.id, { title: value })}
          />
        </section>
      )}
      {children.length > 0 && (
        <Button type="button" className="detail-enter" onClick={() => props.onOpenOverlay(node.id)}>
          <IconEnter size={14} />
          {tr("进入内部")}
        </Button>
      )}
      {node.resource && (
        <div className="resource-reference">
          <span>{tr("来源文件")}</span>
          <Button type="button" onClick={() => props.onOpenResource?.(node.resource!)}>
            {node.resource.path} ↗
          </Button>
        </div>
      )}
      {node.kind === "text" && (
        <section aria-label={tr("完整内容")}>
          <DocumentEditor
            fileOrigin={{ kind: "node", id: node.id }}
            key={node.id}
            id={node.id}
            value={node.text ?? ""}
            version={node.revision}
            onSave={(text, version) => props.onSave(node.id, { text }, version)}
          />
        </section>
      )}
      {node.kind === "group" && (
        <section aria-label={tr("摘要")}>
          <DocumentEditor
            fileOrigin={{ kind: "node", id: node.id }}
            id={node.id}
            value={node.summary ?? ""}
            version={node.revision}
            onSave={(summary, version) => props.onSave(node.id, { summary }, version)}
          />
        </section>
      )}
      {metadata}
    </div>
  );
}
