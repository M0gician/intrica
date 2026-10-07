import type { Rect } from "@intrica/contracts";

/** 相交判定：边界接触也算相交。 */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  );
}

export function pointInRect(point: { x: number; y: number }, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/** 点到矩形的最近距离（内部为 0）。 */
export function pointToRectDistance(point: { x: number; y: number }, rect: Rect): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

export function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function normalizeMarquee(marquee: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}): Rect {
  const x = Math.min(marquee.x1, marquee.x2);
  const y = Math.min(marquee.y1, marquee.y2);
  return {
    x,
    y,
    width: Math.abs(marquee.x2 - marquee.x1),
    height: Math.abs(marquee.y2 - marquee.y1),
  };
}

export type Side = "left" | "right" | "top" | "bottom";

/** 计算把 rect 平移到 bounds 外最近一侧所需的最短位移（含间距）。 */
export function minimalDisplacementOutOf(rect: Rect, bounds: Rect, gap: number): Side {
  const toRight = bounds.x + bounds.width + gap - rect.x;
  const toLeft = rect.x + rect.width - (bounds.x - gap);
  const toBottom = bounds.y + bounds.height + gap - rect.y;
  const toTop = rect.y + rect.height - (bounds.y - gap);
  const candidates: Array<{ side: Side; distance: number }> = [
    { side: "right", distance: Math.max(toRight, 0) },
    { side: "left", distance: Math.max(toLeft, 0) },
    { side: "bottom", distance: Math.max(toBottom, 0) },
    { side: "top", distance: Math.max(toTop, 0) },
  ];
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0]?.side ?? "right";
}

export function displacementFor(rect: Rect, bounds: Rect, gap: number): { dx: number; dy: number } {
  const side = minimalDisplacementOutOf(rect, bounds, gap);
  switch (side) {
    case "right":
      return { dx: bounds.x + bounds.width + gap - rect.x, dy: 0 };
    case "left":
      return { dx: bounds.x - gap - (rect.x + rect.width), dy: 0 };
    case "bottom":
      return { dx: 0, dy: bounds.y + bounds.height + gap - rect.y };
    case "top":
      return { dx: 0, dy: bounds.y - gap - (rect.y + rect.height) };
  }
}

export type ViewTransform = { pan: { x: number; y: number }; zoom: number };

/** 适应画布：把 bounds 缩放到视口安全区域（含边距）并居中。 */
export function fitBoundsToViewport(
  bounds: Rect,
  viewport: { width: number; height: number },
  margin: number,
  minZoom: number,
  maxZoom: number,
): ViewTransform {
  const usableWidth = Math.max(viewport.width - margin * 2, 1);
  const usableHeight = Math.max(viewport.height - margin * 2, 1);
  const rawZoom = Math.min(
    usableWidth / Math.max(bounds.width, 1),
    usableHeight / Math.max(bounds.height, 1),
    maxZoom,
  );
  const zoom = Math.min(Math.max(rawZoom, minZoom), maxZoom);
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  return {
    zoom,
    pan: {
      x: viewport.width / 2 - centerX * zoom,
      y: viewport.height / 2 - centerY * zoom,
    },
  };
}

/** 当前视口在世界坐标下的可视矩形。 */
export function viewWorldRect(
  pan: { x: number; y: number },
  zoom: number,
  viewport: { width: number; height: number },
): Rect {
  return {
    x: -pan.x / zoom,
    y: -pan.y / zoom,
    width: viewport.width / zoom,
    height: viewport.height / zoom,
  };
}

function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * 结果自动聚焦：若 bounds 已完整可见返回 null；
 * 否则在当前缩放下只向出界方向平移；内容放不下时才缩放并居中。
 */
export function ensureBoundsVisible(
  pan: { x: number; y: number },
  zoom: number,
  viewport: { width: number; height: number },
  bounds: Rect,
  margin: number,
  minZoom: number,
  maxZoom: number,
): ViewTransform | null {
  const visible = viewWorldRect(pan, zoom, viewport);
  const padded: Rect = {
    x: visible.x + margin / zoom,
    y: visible.y + margin / zoom,
    width: Math.max(visible.width - (margin * 2) / zoom, 0),
    height: Math.max(visible.height - (margin * 2) / zoom, 0),
  };
  if (rectContainsRect(padded, bounds)) return null;
  const fitsAtCurrentZoom =
    bounds.width + (margin * 2) / zoom <= visible.width &&
    bounds.height + (margin * 2) / zoom <= visible.height;
  if (fitsAtCurrentZoom) {
    let dx = 0;
    let dy = 0;
    if (bounds.x < padded.x) dx = (padded.x - bounds.x) * zoom;
    else if (bounds.x + bounds.width > padded.x + padded.width)
      dx = (padded.x + padded.width - (bounds.x + bounds.width)) * zoom;
    if (bounds.y < padded.y) dy = (padded.y - bounds.y) * zoom;
    else if (bounds.y + bounds.height > padded.y + padded.height)
      dy = (padded.y + padded.height - (bounds.y + bounds.height)) * zoom;
    return {
      zoom,
      pan: {
        x: pan.x + dx,
        y: pan.y + dy,
      },
    };
  }
  return fitBoundsToViewport(bounds, viewport, margin, minZoom, maxZoom);
}
