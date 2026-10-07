import { useEffect, useState } from "react";
import { useSessionConnection } from "../api/connection";
import type { FileContent } from "../api/workspace";
import { tr, useTranslation } from "../i18n";
import { IconImage } from "./icons";
export function isImagePath(path: string) {
  return /\.(?:gif|jpe?g|png|svg|webp)$/i.test(path);
}
export function WorkspaceImagePreview({
  path,
  alt,
  className = "",
  preview = false,
}: {
  path: string;
  alt: string;
  className?: string;
  preview?: boolean;
}) {
  useTranslation();

  const { transport, serverRequest } = useSessionConnection();
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    let objectUrl: string | null = null;
    setSource(null);
    setFailed(false);
    if (preview) {
      void transport
        .fetch(`/api/v2/workspace/image?path=${encodeURIComponent(path)}`, {
          signal: abort.signal,
          credentials: "include",
        })
        .then((response) => {
          if (!response.ok) throw new Error(tr("图片读取失败"));
          return response.blob();
        })
        .then((blob) => {
          if (abort.signal.aborted) return;
          objectUrl = URL.createObjectURL(blob);
          setSource(objectUrl);
        })
        .catch(() => {
          if (!abort.signal.aborted) setFailed(true);
        });
      return () => {
        abort.abort();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
    }
    void serverRequest<FileContent>(
      `file?path=${encodeURIComponent(path)}`,
      undefined,
      "GET",
      abort.signal,
    )
      .then((file) => {
        if (abort.signal.aborted) return;
        if (file.data && file.mime.startsWith("image/"))
          setSource(`data:${file.mime};base64,${file.data}`);
        else setFailed(true);
      })
      .catch(() => {
        if (!abort.signal.aborted) setFailed(true);
      });
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, preview, transport.fetch, serverRequest]);
  if (source && !failed)
    return (
      <img
        className={className}
        src={source}
        alt={alt}
        draggable={false}
        loading={preview ? "lazy" : "eager"}
        decoding="async"
        onError={() => setFailed(true)}
      />
    );
  if (failed)
    return (
      <div className="image-unavailable">
        <IconImage size={28} />
        <span>{tr("图片暂不可用")}</span>
      </div>
    );
  return <div className="image-loading" role="status" aria-label={tr("正在加载图片预览")} />;
}
