import type { FileContent, FileReferenceOrigin } from "@intrica/contracts";
import { type Ref, useState } from "react";
import { DocumentEditor } from "../../components/DocumentEditor";
import { PdfPreview } from "../../components/PdfPreview";
import { tr } from "../../i18n";

export function FilePreview({
  file,
  referenceId,
  origin,
  onDownload,
  busy,
  imageRef,
}: {
  file: FileContent;
  referenceId?: string | undefined;
  origin?: FileReferenceOrigin | undefined;
  onDownload?: (() => void) | undefined;
  busy?: boolean | undefined;
  imageRef?: Ref<HTMLImageElement> | undefined;
}) {
  const [decodeError, setDecodeError] = useState<string | null>(null);
  if (decodeError === file.data)
    return <p role="status">{tr("文件内容损坏或无法解码，可下载原文件检查。")}</p>;
  if (file.previewError)
    return (
      <p role="status">
        {tr(
          file.previewError === "too_large"
            ? "文件超过预览限制，可下载原文件。"
            : file.previewError === "corrupt"
              ? "文件内容损坏或无法解码，可下载原文件检查。"
              : "此文件没有预览器，可下载原文件。",
        )}
      </p>
    );
  if (file.mime === "application/pdf")
    return (
      <PdfPreview
        {...(referenceId ? { referenceId } : { path: file.path })}
        title={file.name}
        onDownload={onDownload}
        downloadBusy={busy}
      />
    );
  if (file.data && file.mime.startsWith("image/"))
    return (
      <img
        ref={imageRef}
        alt={file.name}
        src={`data:${file.previewMime ?? file.mime};base64,${file.data}`}
        onError={() => setDecodeError(file.data!)}
      />
    );
  return (
    <DocumentEditor
      id={referenceId ?? file.path}
      fileName={file.name}
      value={file.text ?? ""}
      readOnly
      fileOrigin={origin ? { ...origin, ...(file.path ? { filePath: file.path } : {}) } : undefined}
      fileMime={file.mime}
    />
  );
}
