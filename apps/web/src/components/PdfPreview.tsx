import { useEffect, useState } from "react";
import { type SessionConnection, useSessionConnection } from "../api/connection";
import { tr, useTranslation } from "../i18n";
import { Button } from "../ui/button";
import { IconChevronLeft, IconChevronRight, IconFit, IconMinus, IconPlus } from "./icons";
import "./pdf-preview.css";

type PdfSource = { nodeId: string; path?: never } | { path: string; nodeId?: never };
type PdfPage = {
  page: number;
  pageCount: number;
  text: string;
  hasText: boolean;
  image?: string;
  totalChars?: number;
  nextCharOffset?: number | null;
};
type PdfPreviewProps = PdfSource & {
  title?: string;
  onDownload?: (() => void) | undefined;
  downloadBusy?: boolean | undefined;
};

export function isPdfPath(path: string) {
  return /\.pdf$/i.test(path);
}

/** Classify only explicit server evidence; preserve details for unknown failures. */
function pdfFailure(reason: unknown) {
  const error = reason as { code?: string; serverMessage?: string; message?: string };
  const detail = error?.serverMessage ?? error?.message ?? tr("PDF 读取失败");
  const message =
    error?.code === "LIMIT_REACHED"
      ? tr("PDF 处理暂时繁忙，请稍后重试。")
      : /PDF is encrypted/.test(detail)
        ? tr("此 PDF 已加密，请先在此设备上解锁，再上传或替换原文件。")
        : /exceeds|超过|超出|20MiB|20MB|Image exceeded maximum allowed size/.test(detail)
          ? tr("PDF 超出处理限制。可尝试仅提取文本，或下载原文件后拆分文档。")
          : /Invalid PDF|InvalidPDF|PDF structure|Invalid XRef/.test(detail)
            ? tr("PDF 文件结构损坏或不受支持，请下载原文件检查。")
            : tr("PDF 读取失败。请检查连接后重试，或尝试仅提取文本。");
  return { message, detail };
}

export function PdfPreview(props: PdfPreviewProps) {
  const connection = useSessionConnection();
  const documentKey = props.nodeId ? `node:${props.nodeId}` : `path:${props.path}`;
  return (
    <PdfDocument
      key={`${connection.bindingId}:${documentKey}`}
      {...props}
      connection={connection}
      documentKey={documentKey}
    />
  );
}

/** The connection-bound keyed instance fences transports that ignore abort.
 * Only page/mode are persisted, never document content or credentials. */
function PdfDocument({
  nodeId,
  path,
  title,
  onDownload,
  downloadBusy,
  connection,
  documentKey,
}: PdfPreviewProps & { connection: SessionConnection; documentKey: string }) {
  useTranslation();
  const readingKey = `pdf-reading:${documentKey}`;
  const [position, setPosition] = useState(() => {
    try {
      const saved = JSON.parse(connection.storage.getItem(readingKey) ?? "null");
      if (Number.isInteger(saved?.page) && saved.page >= 1 && saved.page <= 2000)
        return { page: saved.page as number, textOnly: saved.textOnly === true };
    } catch {
      /* Storage may be unavailable. */
    }
    return { page: 1, textOnly: false };
  });
  const { page, textOnly } = position;
  const [jump, setJump] = useState(String(page));
  const [zoom, setZoom] = useState(1);
  const [cursor, setCursor] = useState(0);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<PdfPage | null>(null);
  const [error, setError] = useState<ReturnType<typeof pdfFailure> | null>(null);
  const [loading, setLoading] = useState(true);
  const [imageFailed, setImageFailed] = useState(false);
  const changePosition = (nextPage: number, nextTextOnly = textOnly) => {
    setPosition({ page: nextPage, textOnly: nextTextOnly });
    setJump(String(nextPage));
    setCursor(0);
    setResult(null);
    setRevision((current) => current + 1);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision retries the same page/cursor.
  useEffect(() => {
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, connection.signal]);
    setLoading(true);
    setError(null);
    setImageFailed(false);
    const query = `page=${page}&render=${!textOnly && cursor === 0}&characterOffset=${cursor}&characterLimit=12000`;
    const url = nodeId
      ? `/api/v2/nodes/${encodeURIComponent(nodeId)}/pdf?${query}`
      : `/api/v2/workspace/pdf?path=${encodeURIComponent(path!)}&${query}`;
    void connection.transport
      .request<PdfPage>(url, { signal })
      .then((value) => {
        if (signal.aborted) return;
        if (
          value.page !== page ||
          !Number.isInteger(value.pageCount) ||
          value.pageCount < page ||
          value.pageCount > 2000 ||
          typeof value.text !== "string" ||
          (value.nextCharOffset != null &&
            (!Number.isInteger(value.nextCharOffset) ||
              value.nextCharOffset <= cursor ||
              value.nextCharOffset > 10000000))
        )
          throw new Error(tr("PDF 页面数据无效"));
        setResult((previous) =>
          cursor > 0 && previous?.page === page
            ? {
                ...value,
                ...(previous.image ? { image: previous.image } : {}),
                text: previous.text + value.text,
              }
            : value,
        );
        setLoading(false);
        try {
          connection.storage.setItem(readingKey, JSON.stringify({ page, textOnly }));
        } catch {
          /* Best-effort reading position. */
        }
      })
      .catch((reason) => {
        if (!signal.aborted) {
          setError(pdfFailure(reason));
          setLoading(false);
        }
      });
    return () => abort.abort();
  }, [connection, nodeId, path, page, textOnly, cursor, revision, readingKey]);
  const visible = result?.page === page ? result : null;
  return (
    <section className="pdf-preview" aria-label={tr("PDF 预览")} aria-busy={loading}>
      <div className="pdf-preview-toolbar" role="toolbar" aria-label={tr("PDF 分页与缩放")}>
        <div className="pdf-preview-group pdf-preview-pages">
          <Button
            type="button"
            size="icon"
            aria-label={tr("上一页")}
            title={tr("上一页")}
            disabled={loading || page <= 1}
            onClick={() => changePosition(page - 1)}
          >
            <IconChevronLeft />
          </Button>
          <span aria-live="polite">
            {visible
              ? tr("第 {{page}} / {{count}} 页", { page, count: visible.pageCount })
              : tr("第 {{page}} 页", { page })}
          </span>
          <Button
            type="button"
            size="icon"
            aria-label={tr("下一页")}
            title={tr("下一页")}
            disabled={loading || !visible || page >= visible.pageCount}
            onClick={() => changePosition(page + 1)}
          >
            <IconChevronRight />
          </Button>
        </div>
        <form
          className="pdf-preview-jump"
          onSubmit={(event) => {
            event.preventDefault();
            const target = Number(jump);
            if (Number.isInteger(target) && target >= 1 && target <= (visible?.pageCount ?? 2000))
              changePosition(target);
          }}
        >
          <input
            type="number"
            min={1}
            max={visible?.pageCount ?? 2000}
            value={jump}
            onChange={(event) => setJump(event.target.value)}
            aria-label={tr("PDF 页码")}
          />
          <Button type="submit" disabled={loading}>
            {tr("跳转")}
          </Button>
        </form>
        {!textOnly && (
          <div className="pdf-preview-group pdf-preview-zoom">
            <Button
              type="button"
              size="icon"
              aria-label={tr("缩小 PDF")}
              title={tr("缩小 PDF")}
              disabled={zoom <= 0.5}
              onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}
            >
              <IconMinus />
            </Button>
            <span>{Math.round(zoom * 100)}%</span>
            <Button
              type="button"
              size="icon"
              aria-label={tr("放大 PDF")}
              title={tr("放大 PDF")}
              disabled={zoom >= 3}
              onClick={() => setZoom(Math.min(3, zoom + 0.25))}
            >
              <IconPlus />
            </Button>
            <Button
              type="button"
              size="icon"
              aria-label={tr("适应宽度")}
              title={tr("适应宽度")}
              onClick={() => setZoom(1)}
            >
              <IconFit />
            </Button>
          </div>
        )}
      </div>
      <div className="pdf-preview-actions">
        <Button type="button" disabled={loading} onClick={() => changePosition(page, !textOnly)}>
          {textOnly ? tr("查看页面图像") : tr("仅提取文本")}
        </Button>
        {onDownload && (
          <Button type="button" disabled={downloadBusy} onClick={onDownload}>
            {tr("下载原文件")}
          </Button>
        )}
      </div>
      {loading && <p role="status">{tr("正在读取 PDF 页面…")}</p>}
      {error && (
        <div role="alert">
          <p>{error.message}</p>
          <details>
            <summary>{tr("技术详情")}</summary>
            <p>{error.detail}</p>
          </details>
          <Button type="button" onClick={() => setRevision(revision + 1)}>
            {tr("重试")}
          </Button>
          {page !== 1 && (
            <Button type="button" onClick={() => changePosition(1)}>
              {tr("返回第一页")}
            </Button>
          )}
        </div>
      )}
      {visible && (
        <>
          {!textOnly && (
            <div className="pdf-preview-stage">
              {visible.image && !imageFailed ? (
                <img
                  src={`data:image/png;base64,${visible.image}`}
                  alt={tr("{{title}} 第 {{page}} 页", { title: title ?? "PDF", page })}
                  draggable={false}
                  style={{ width: `${zoom * 100}%` }}
                  onError={() => setImageFailed(true)}
                />
              ) : (
                <p>{tr("PDF 页面图像暂不可用")}</p>
              )}
            </div>
          )}
          {!visible.hasText && (
            <p className="pdf-preview-note">
              {textOnly
                ? tr("此页没有可提取文本，未执行 OCR。可查看页面图像或下载原文件。")
                : tr("此页没有可提取文本；请检查页面图像（未执行 OCR）。")}
            </p>
          )}
          {visible.hasText && (
            <details className="pdf-preview-text" open={textOnly || undefined}>
              <summary>{tr("可提取文本")}</summary>
              <pre>{visible.text}</pre>
              {visible.nextCharOffset != null && (
                <Button
                  type="button"
                  disabled={loading}
                  onClick={() => setCursor(visible.nextCharOffset!)}
                >
                  {tr("继续加载本页文本")}
                </Button>
              )}
              <p>{tr("文本提取可能不保留阅读顺序；版面和图表请以页面图像为准。")}</p>
            </details>
          )}
        </>
      )}
    </section>
  );
}
