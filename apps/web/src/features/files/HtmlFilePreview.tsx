import type { FileContent, FileReferenceOrigin } from "@intrica/contracts";
import { useEffect, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { tr } from "../../i18n";
import { encodeFileReference, isLocalFile, isOwnerFileUrl } from "./reference";

const prefix = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; navigate-to 'none';"><style>body{font:14px/1.6 system-ui;margin:20px;overflow-wrap:anywhere}img{max-width:100%}pre{overflow:auto}</style>`;
export function HtmlFilePreview({
  text,
  origin,
}: {
  text: string;
  origin?: FileReferenceOrigin | undefined;
}) {
  const connection = useSessionConnection();
  const identity = JSON.stringify([connection.bindingId, origin, text]);
  const [preview, setPreview] = useState<{ identity: string; html: string }>();
  const source = origin ? JSON.stringify(origin) : "";
  useEffect(() => {
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, connection.signal]);
    const template = document.createElement("template");
    template.innerHTML = text;
    // The frame stays sandboxed. Remove alternate resource/navigation channels too.
    for (const element of template.content.querySelectorAll(
      "script,base,meta,iframe,object,embed,source",
    ))
      element.remove();
    const images = [...template.content.querySelectorAll("img")];
    const paths = images.map((img) => img.getAttribute("src") ?? "");
    for (const img of images) {
      img.removeAttribute("srcset");
      img.removeAttribute("src");
    }
    for (const link of template.content.querySelectorAll("a")) link.removeAttribute("href");
    const publish = () => {
      if (!signal.aborted) setPreview({ identity, html: template.innerHTML });
    };
    publish();
    void (async () => {
      // Bound concurrency and duplicate reads in documents with repeated images.
      const cache = new Map<string, string>();
      for (let i = 0; i < images.length && !signal.aborted; i++) {
        const path = paths[i]!;
        if (/^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,/i.test(path)) {
          images[i]!.setAttribute("src", path);
          continue;
        }
        if (!source || !isLocalFile(path) || isOwnerFileUrl(path)) continue;
        try {
          let data = cache.get(path);
          if (!data) {
            const reference = encodeFileReference({
              serverId: connection.serverId,
              origin: JSON.parse(source),
              path,
            });
            const file = await connection.transport.request<FileContent>(
              `/api/v2/files/preview?reference=${reference}`,
              { signal },
            );
            if (
              file.serverId !== connection.serverId ||
              !file.data ||
              !file.mime.startsWith("image/")
            )
              continue;
            data = `data:${file.previewMime ?? file.mime};base64,${file.data}`;
            cache.set(path, data);
          }
          images[i]!.setAttribute("src", data);
        } catch {
          images[i]!.setAttribute("alt", `${images[i]!.alt} · ${tr("文件引用不可用")}`);
        }
      }
      publish();
    })();
    return () => abort.abort();
  }, [connection, source, text, identity]);
  return (
    <iframe
      title={tr("HTML 预览")}
      sandbox=""
      srcDoc={prefix + (preview?.identity === identity ? preview.html : "")}
    />
  );
}
