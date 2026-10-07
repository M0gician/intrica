import type {
  ContextPreview,
  PreviewOperationRequest,
  PreviewResponse,
  Rect,
} from "@intrica/contracts";
import { useCallback, useEffect, useState } from "react";
import { tr, useTranslation } from "../i18n";
import type { OperationIntent } from "../state/types";
import { Button } from "../ui/button";
import { OPERATION_LABELS } from "../utils/labels";
import { useVirtualAnchor } from "./useVirtualAnchor";
export type ContextPreviewDialogProps = {
  intent: OperationIntent;
  /** 选区包围盒（视口坐标）。 */
  anchorRect: Rect;
  nodeTitle: (nodeId: string) => string;
  loadPreview: (request: PreviewOperationRequest) => Promise<PreviewResponse>;
  onConfirm: (request: PreviewOperationRequest) => void;
  onClose: () => void;
  onReadPdf?: ((nodeIds: string[]) => void) | undefined;
};
export function ContextPreviewDialog(props: ContextPreviewDialogProps) {
  useTranslation();

  const { intent, onClose } = props;
  const [includeConnected, setIncludeConnected] = useState(false);
  const [includeDescendants, setIncludeDescendants] = useState<string[]>([]);
  const [instruction, setInstruction] = useState("");
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { refs, floatingStyles } = useVirtualAnchor(props.anchorRect, {
    placement: "right-start",
    gap: 8,
  });
  const buildRequest = useCallback((): PreviewOperationRequest => {
    return {
      type: intent.type,
      scopeId: intent.scopeId,
      selection: intent.selection,
      includeDescendants,
      includeConnected,
      instruction,
    };
  }, [intent, includeDescendants, includeConnected, instruction]);
  const { loadPreview } = props;
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadPreview(buildRequest())
      .then((response) => {
        if (!cancelled) {
          setPreview(response.preview);
          setError(null);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : tr("预览加载失败"));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [buildRequest, loadPreview]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);
  const visionBlocked = preview?.visionRequired === true && !preview.visionSupported;
  const descendantEntries = preview ? Object.entries(preview.descendantCounts) : [];
  return (
    <div
      ref={refs.setFloating}
      style={floatingStyles}
      className="context-preview-dialog"
      role="dialog"
      aria-label={tr("{{v0}}上下文预览", { v0: OPERATION_LABELS[intent.type] })}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <h2>
        {OPERATION_LABELS[intent.type]}
        {tr("：确认发送的上下文")}
      </h2>

      {error && <p role="alert">{error}</p>}
      {!!preview?.blockedPdfNodeIds?.length && (
        <div role="alert">
          <p>{tr("PDF 需由 Agent 按页阅读，暂不支持画布生成")}</p>
          {props.onReadPdf && (
            <Button type="button" onClick={() => props.onReadPdf!(preview.blockedPdfNodeIds!)}>
              {tr("交给 Agent 阅读 PDF")}
            </Button>
          )}
        </div>
      )}

      {preview && (
        <>
          <section aria-label={tr("将发送的节点")}>
            <h3>
              {tr("将发送的节点（")}
              {preview.draft.nodes.length}）
            </h3>
            <ul>
              {preview.draft.nodes.map((node) => (
                <li key={node.id}>
                  {node.title ?? props.nodeTitle(node.id)}（
                  {node.kind === "text"
                    ? tr("文字")
                    : node.kind === "image"
                      ? tr("图片")
                      : node.kind === "agent"
                        ? "Agent"
                        : node.kind === "todo"
                          ? tr("待办")
                          : tr("容器")}
                  ）
                </li>
              ))}
            </ul>
            <p>
              {tr("已确认连接：")}
              {preview.draft.edges.length}
              {tr("条")}
            </p>
          </section>

          <section aria-label={tr("可选上下文")}>
            {preview.neighborIds.length > 0 && (
              <label>
                <input
                  type="checkbox"
                  checked={includeConnected}
                  onChange={(event) => setIncludeConnected(event.target.checked)}
                />
                {tr("包含已连接节点/关系（")}
                {preview.neighborIds.length}）
              </label>
            )}
            {includeConnected && preview.neighborIds.length > 0 && (
              <ul>
                {preview.neighborIds.map((id) => (
                  <li key={id}>{props.nodeTitle(id)}</li>
                ))}
              </ul>
            )}
            {descendantEntries.map(([nodeId, count]) => (
              <label key={nodeId}>
                <input
                  type="checkbox"
                  checked={includeDescendants.includes(nodeId)}
                  onChange={(event) => {
                    setIncludeDescendants((current) =>
                      event.target.checked
                        ? [...current, nodeId]
                        : current.filter((id) => id !== nodeId),
                    );
                  }}
                />
                {tr("包含「")}
                {props.nodeTitle(nodeId)}
                {tr("」内部")}
                {tr("{{v0}} 项", { v0: count })}
              </label>
            ))}
          </section>

          <section aria-label={tr("预算")}>
            <p>
              {tr("预算：")}
              {preview.estimatedChars} / {preview.budgetChars}
              {tr("字符")}
            </p>
            {preview.draft.omittedNodeIds.length > 0 && (
              <div>
                <p>{tr("超出预算，已省略以下节点：")}</p>
                <ul>
                  {preview.draft.omittedNodeIds.map((id) => (
                    <li key={id}>{props.nodeTitle(id)}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {preview.visionRequired && (
            <p role={visionBlocked ? "alert" : undefined} className="vision-notice">
              {visionBlocked
                ? tr("选区包含图片，但当前模型不支持视觉输入，无法执行本次操作")
                : tr("选区包含图片，将以受控资源发送给模型")}
            </p>
          )}

          <label className="instruction-field">
            {tr("补充要求")}
            <textarea
              value={instruction}
              rows={3}
              placeholder={tr("可选：对本次生成的补充要求")}
              onChange={(event) => setInstruction(event.target.value)}
            />
          </label>
        </>
      )}

      <div className="dialog-actions">
        <Button
          type="button"
          disabled={
            loading ||
            error !== null ||
            preview === null ||
            visionBlocked ||
            !!preview.blockedPdfNodeIds?.length
          }
          onClick={() => props.onConfirm(buildRequest())}
        >
          {tr("确认")}
          {OPERATION_LABELS[intent.type]}
        </Button>
        <Button type="button" onClick={props.onClose}>
          {tr("取消")}
        </Button>
      </div>
    </div>
  );
}
