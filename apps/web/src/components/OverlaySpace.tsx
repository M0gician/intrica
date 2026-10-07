import * as React from "react";
import { startPointerSession } from "../features/canvas/pointer-session";
import { tr, useTranslation } from "../i18n";
import type { OverlaySpaceState } from "../state/types";
import { normalizeMarquee, rectsIntersect } from "../utils/geometry";
import type { BreadcrumbItem } from "./TopBar";
export type OverlaySpaceProps = {
  overlay: OverlaySpaceState;
  contentOffset?: {
    x: number;
    y: number;
  };
  /** 面包屑路径（根在前，容器在最后）。 */
  path: BreadcrumbItem[];
  onClose: () => void;
  onMove: (bounds: import("@intrica/contracts").Rect) => void;
  /** 预渲染的连线层（局部坐标）。 */
  edgeLayer: React.ReactNode;
  /** 预渲染的子节点卡片（局部坐标）。 */
  children: React.ReactNode;
  selectableRects?: ReadonlyMap<
    string,
    {
      x: number;
      y: number;
      width: number;
      height: number;
    }
  >;
  onMarqueeSelection?: (ids: string[], additive: boolean) => void;
};

export function OverlaySpace(props: OverlaySpaceProps) {
  useTranslation();
  const { overlay } = props;
  const title = props.path[props.path.length - 1]?.title ?? tr("内部空间");
  const contentRef = React.useRef<HTMLDivElement>(null);
  const spaceRef = React.useRef<HTMLDivElement>(null);
  const cancelSession = React.useRef<(() => void) | undefined>(undefined);
  const [marquee, setMarquee] = React.useState<import("@intrica/contracts").Rect | null>(null);
  React.useEffect(() => () => cancelSession.current?.(), []);
  return (
    <section
      ref={spaceRef}
      data-canvas-overlay
      className={`overlay-space${overlay.readonly ? " overlay-readonly" : ""}`}
      style={{
        left: overlay.bounds.x,
        top: overlay.bounds.y,
        width: overlay.bounds.width,
        height: overlay.bounds.height,
      }}
      aria-label={tr("临时内部空间：{{v0}}{{v1}}", {
        v0: title,
        v1: overlay.readonly ? tr("（候选预览）") : "",
      })}
    >
      <header
        className="overlay-header"
        data-canvas-overlay-header
        title={tr("拖动标题移动容器；按住 Alt 拖动子元素可移出容器")}
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as Element).closest("button")) return;
          event.stopPropagation();
          const scale = spaceRef.current!.getBoundingClientRect().width / overlay.bounds.width;
          const start = { x: event.clientX, y: event.clientY, bounds: overlay.bounds };
          cancelSession.current = startPointerSession({
            pointerId: event.pointerId,
            onMove: (point) =>
              props.onMove({
                ...start.bounds,
                x: start.bounds.x + (point.clientX - start.x) / scale,
                y: start.bounds.y + (point.clientY - start.y) / scale,
              }),
            onUp: () => {},
            onCancel: () => props.onMove(start.bounds),
          });
        }}
      >
        <nav className="overlay-breadcrumbs" aria-label={tr("空间路径")}>
          {props.path.map((item, index) => (
            <span key={item.id}>
              {index > 0 && <span className="breadcrumb-separator">&gt;</span>}
              {item.title ?? tr("未命名")}
            </span>
          ))}
          {overlay.readonly && (
            <span className="tier-label tier-label-candidate">{tr("候选预览")}</span>
          )}
        </nav>
        <button
          type="button"
          className="overlay-close"
          onClick={props.onClose}
          aria-label={tr("关闭临时内部空间")}
        >
          {tr("关闭")}
        </button>
      </header>
      <div
        className="overlay-body"
        tabIndex={-1}
        onPointerDown={(event) => {
          if (
            overlay.readonly ||
            event.button !== 0 ||
            event.pointerType === "touch" ||
            (event.target as Element).closest("[data-node-id], [data-canvas-edge], button")
          )
            return;
          event.stopPropagation();
          event.currentTarget.focus({ preventScroll: true });
          const origin = contentRef.current!.getBoundingClientRect();
          const scale =
            event.currentTarget.getBoundingClientRect().width / event.currentTarget.offsetWidth;
          const start = { x: event.clientX, y: event.clientY };
          const additive = event.shiftKey;
          let active = false;
          const rectAt = (point: PointerEvent) =>
            normalizeMarquee({
              x1: (start.x - origin.left) / scale,
              y1: (start.y - origin.top) / scale,
              x2: (point.clientX - origin.left) / scale,
              y2: (point.clientY - origin.top) / scale,
            });
          cancelSession.current = startPointerSession({
            pointerId: event.pointerId,
            onMove: (point) => {
              if (Math.hypot(point.clientX - start.x, point.clientY - start.y) < 4) return;
              active = true;
              setMarquee(rectAt(point));
            },
            onUp: (point) => {
              const rect = rectAt(point);
              const ids = active
                ? [...(props.selectableRects ?? [])]
                    .filter(([, node]) => rectsIntersect(rect, node))
                    .map(([id]) => id)
                : [];
              props.onMarqueeSelection?.(ids, additive);
              setMarquee(null);
            },
            onCancel: () => setMarquee(null),
          });
        }}
      >
        <div
          className="overlay-content"
          ref={contentRef}
          style={{
            left: 16 + (props.contentOffset?.x ?? 0),
            top: 16 + (props.contentOffset?.y ?? 0),
          }}
        >
          {marquee && (
            <div
              className="marquee overlay-marquee"
              style={{
                left: marquee.x,
                top: marquee.y,
                width: marquee.width,
                height: marquee.height,
              }}
            />
          )}
          {props.edgeLayer}
          {props.children}
        </div>
      </div>
    </section>
  );
}
