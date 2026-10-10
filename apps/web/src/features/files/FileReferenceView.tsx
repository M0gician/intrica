import type { FileContent, FileReferenceOrigin } from "@intrica/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useSessionConnection } from "../../api/connection";
import { tr } from "../../i18n";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { DownloadStatus, useFileDownload } from "./download";
import { FilePreview } from "./FilePreview";
import { encodeFileReference } from "./reference";
import "./file-reference.css";

type FileReferenceProps = {
  origin: FileReferenceOrigin;
  path?: string | undefined;
  image?: boolean;
  children?: ReactNode;
  label?: string | undefined;
  embedded?: boolean;
};
export function FileReferenceView(props: FileReferenceProps) {
  const connection = useSessionConnection();
  return (
    <ReferenceContent
      key={`${connection.bindingId}:${props.origin.kind}:${props.origin.id}:${props.origin.filePath ?? ""}:${props.path ?? ""}`}
      {...props}
    />
  );
}
function ReferenceContent({
  origin,
  path,
  image = false,
  embedded = false,
  children,
  label,
}: FileReferenceProps) {
  const connection = useSessionConnection();
  const referenceId = encodeFileReference({
    serverId: connection.serverId,
    origin,
    ...(path ? { path } : {}),
  });
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<(FileContent & { serverId: string }) | null>(null);
  const [error, setError] = useState("");
  const download = useFileDownload();
  useEffect(() => {
    setFile(null);
    setError("");
    if (!image && !open && !embedded) return;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, connection.signal]);
    void connection.transport
      .request<FileContent & { serverId: string }>(
        `/api/v2/files/preview?reference=${encodeURIComponent(referenceId)}`,
        { signal },
      )
      .then((value) => {
        if (signal.aborted) return;
        if (value.serverId !== connection.serverId) throw new Error(tr("文件属于其他服务器"));
        setFile(value);
      })
      .catch((error) => {
        if (!signal.aborted) setError(error.message);
      });
    return () => abort.abort();
  }, [connection, referenceId, image, open, embedded]);
  const save = () => file && download.start({ referenceId, name: file.name });
  if (embedded)
    return (
      <section className="file-reference-preview">
        {error ? (
          <p role="alert">{error}</p>
        ) : !file ? (
          <p role="status">{tr("正在读取文件")}</p>
        ) : (
          <>
            <div className="tool-subbar">
              <span>{file.name}</span>
              <Button disabled={download.busy} onClick={() => void save()}>
                {tr("下载到此设备")}
              </Button>
            </div>
            <DownloadStatus download={download} />
            <FilePreview
              file={file}
              referenceId={referenceId}
              origin={origin}
              onDownload={() => void save()}
              busy={download.busy}
            />
          </>
        )}
      </section>
    );
  return (
    <>
      <span className="file-reference">
        {image && file?.data && file.mime.startsWith("image/") && !error ? (
          <button type="button" className="file-reference-image" onClick={() => setOpen(true)}>
            <img
              src={`data:${file.previewMime ?? file.mime};base64,${file.data}`}
              alt={label ?? file.name}
              onError={() => setError(tr("图片暂不可用"))}
            />
          </button>
        ) : (
          <button type="button" className="file-reference-link" onClick={() => setOpen(true)}>
            {children ?? label ?? tr("查看文件")}
          </button>
        )}
        {image && error && (
          <span role="status">
            {tr("文件引用不可用")} · {error}
          </span>
        )}
      </span>
      {open &&
        createPortal(
          <Dialog
            label={file?.name ?? tr("文件预览")}
            onClose={() => setOpen(false)}
            className="file-reference-dialog"
          >
            <header>
              <h2>{file?.name ?? label ?? tr("文件预览")}</h2>
              <Button aria-label={tr("关闭")} onClick={() => setOpen(false)}>
                ×
              </Button>
            </header>
            {error ? (
              <p role="alert">{error}</p>
            ) : !file ? (
              <p role="status">{tr("正在读取文件")}</p>
            ) : (
              <>
                <Button disabled={download.busy} onClick={() => void save()}>
                  {tr("下载到此设备")}
                </Button>
                <DownloadStatus download={download} />
                <FilePreview
                  file={file}
                  referenceId={referenceId}
                  origin={origin}
                  onDownload={() => void save()}
                  busy={download.busy}
                />
              </>
            )}
          </Dialog>,
          document.body,
        )}
    </>
  );
}
