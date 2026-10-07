import { useEffect, useState } from "react";
import { type SessionConnection, useSessionConnection } from "../api/connection";
import { useBrowserSessionRevision } from "../desktop/browser-session";
import { tr, useTranslation } from "../i18n";
import { IconBrowser } from "./icons";

type Preview = {
  image: string | null;
  title: string;
  description: string;
  snapshot: boolean;
};
const inFlight = new Map<string, Promise<Preview>>();
function load(url: string, title: string, connection: SessionConnection, revision: number) {
  const { transport } = connection;
  const cacheKey = `${connection.bindingId}:${revision}:${url}`;
  const existing = inFlight.get(cacheKey);
  if (existing) return existing;
  const request = (async () => {
    const native = window.intricaDesktop?.browser.preview;
    if (native)
      try {
        const shot = await native(url);
        return { image: shot.dataUrl, title: shot.title || title, description: "", snapshot: true };
      } catch {}
    try {
      const meta = await transport.request<{
        title?: string;
        description?: string;
        imageUrl?: string;
      }>(`/api/v2/workspace/web-title?url=${encodeURIComponent(url)}`);
      return {
        image: meta.imageUrl ?? null,
        title: meta.title || title,
        description: meta.description ?? "",
        snapshot: false,
      };
    } catch {
      return {
        image: null,
        title,
        description: tr("此网站未提供预览，双击打开网页。"),
        snapshot: false,
      };
    }
  })();
  inFlight.set(cacheKey, request);
  const forget = () => {
    if (inFlight.get(cacheKey) === request) inFlight.delete(cacheKey);
  };
  void request.then(forget, forget);
  return request;
}
export function WebPreview({ url, title }: { url: string; title: string }) {
  useTranslation();

  const connection = useSessionConnection();
  const revision = useBrowserSessionRevision();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    setPreview(null);
    setFailed(false);
    void load(url, title, connection, revision).then((value) => {
      if (current) setPreview(value);
    });
    return () => {
      current = false;
    };
  }, [url, title, connection, revision]);
  return (
    <figure className="bookmark-card-preview" aria-label={tr("网页预览：{{v0}}", { v0: title })}>
      {preview?.image && !failed ? (
        <img
          src={preview.image}
          alt={
            preview.snapshot
              ? tr("{{v0}} 的网页快照", { v0: preview.title })
              : tr("{{v0}} 的网站预览图", { v0: preview.title })
          }
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="bookmark-preview-summary">
          <IconBrowser size={24} />
          <strong className="bookmark-preview-title">{preview?.title ?? title}</strong>
          <p>
            {preview?.description ||
              (preview ? new URL(url).hostname : tr("正在读取网页预览\u2026"))}
          </p>
        </div>
      )}
      {preview && (
        <span className="bookmark-preview-kind">
          {preview.snapshot ? tr("网页快照") : tr("网站摘要")}
        </span>
      )}
    </figure>
  );
}
