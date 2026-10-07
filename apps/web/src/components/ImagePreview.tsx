import { useLayoutEffect, useRef, useState } from "react";
import { useSessionConnection } from "../api/connection";
import { tr, useTranslation } from "../i18n";
import { IconButton, IconFit, IconImage, IconRefresh } from "./icons";
export function ImagePreview({ assetId, alt }: { assetId?: string | undefined; alt: string }) {
  useTranslation();

  const { assetUrl } = useSessionConnection();
  const stage = useRef<HTMLElement>(null);
  const zoomCenter = useRef<{
    x: number;
    y: number;
  } | null>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const source = assetId ? assetUrl(`/api/v2/assets/${encodeURIComponent(assetId)}`) : "";
  useLayoutEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBounds({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);
  const fit = natural.width
    ? Math.min(
        1,
        Math.max(1, bounds.width - 24) / natural.width,
        Math.max(1, bounds.height - 24) / natural.height,
      )
    : 1;
  const scale = zoom ?? fit;
  useLayoutEffect(() => {
    const element = stage.current;
    const center = zoomCenter.current;
    if (!element || !center) return;
    element.scrollLeft =
      center.x * Math.max(bounds.width, natural.width * scale + 24) - bounds.width / 2;
    element.scrollTop =
      center.y * Math.max(bounds.height, natural.height * scale + 24) - bounds.height / 2;
    zoomCenter.current = null;
  }, [scale, bounds, natural]);
  const resize = (value: number | null) => {
    if (stage.current) {
      const element = stage.current;
      zoomCenter.current = {
        x: (element.scrollLeft + element.clientWidth / 2) / element.scrollWidth,
        y: (element.scrollTop + element.clientHeight / 2) / element.scrollHeight,
      };
    }
    setZoom(value === null ? null : Math.min(4, Math.max(0.1, value)));
  };
  return (
    <div className="image-viewer">
      <div className="image-viewer-toolbar" role="toolbar" aria-label={tr("图片缩放")}>
        <IconButton
          label={tr("缩小图片")}
          disabled={!natural.width || failed}
          onClick={() => resize(scale / 1.25)}
        >
          <span aria-hidden="true">−</span>
        </IconButton>
        <span className="image-viewer-scale">
          {natural.width && !failed ? `${Math.round(scale * 100)}%` : "—"}
        </span>
        <IconButton
          label={tr("放大图片")}
          disabled={!natural.width || failed}
          onClick={() => resize(scale * 1.25)}
        >
          <span aria-hidden="true">+</span>
        </IconButton>
        <IconButton
          label={tr("适应图片")}
          disabled={!natural.width || failed}
          onClick={() => resize(null)}
        >
          <IconFit />
        </IconButton>
        <button
          type="button"
          className="image-native-size"
          disabled={!natural.width || failed}
          onClick={() => resize(1)}
          title={tr("按原始像素显示")}
        >
          1:1
        </button>
        {source && (
          <a
            className="image-original-link"
            href={source}
            target="_blank"
            rel="noopener noreferrer"
          >
            {tr("查看原图 \u2197")}
          </a>
        )}
      </div>
      <section
        className="image-preview-stage"
        ref={stage}
        aria-label={tr("图片预览")}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: 键盘用户需要聚焦预览区后用方向键滚动原图。
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0 || !natural.width || failed) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            left: event.currentTarget.scrollLeft,
            top: event.currentTarget.scrollTop,
          };
        }}
        onPointerMove={(event) => {
          if (drag.current) {
            event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX;
            event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY;
          }
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      >
        {failed || !source ? (
          <div className="image-unavailable">
            <IconImage size={32} />
            <p>{tr("图片暂时无法读取")}</p>
            {source && (
              <IconButton
                label={tr("重新加载图片")}
                onClick={() => {
                  setFailed(false);
                  setRevision((v) => v + 1);
                }}
              >
                <IconRefresh />
              </IconButton>
            )}
          </div>
        ) : (
          <div
            className="image-preview-plane"
            style={{
              width: Math.max(bounds.width, natural.width * scale + 24),
              height: Math.max(bounds.height, natural.height * scale + 24),
            }}
          >
            <img
              key={revision}
              className="inspector-image"
              src={source}
              alt={alt}
              draggable={false}
              style={
                natural.width
                  ? { width: natural.width * scale, height: natural.height * scale }
                  : undefined
              }
              onLoad={(e) => {
                setNatural({
                  width: e.currentTarget.naturalWidth,
                  height: e.currentTarget.naturalHeight,
                });
                setFailed(false);
              }}
              onError={() => setFailed(true)}
            />
          </div>
        )}
      </section>
      {natural.width > 0 && !failed && (
        <p className="image-dimensions">
          {natural.width} × {natural.height} px
        </p>
      )}
    </div>
  );
}
