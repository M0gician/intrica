import type { Rect } from "@intrica/contracts";
import {
  CONTAINER_PADDING,
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  GRID_GAP,
} from "@intrica/contracts";

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  );
}

export function selectionBounds(nodes: Array<{ position: Rect }>): Rect | null {
  if (nodes.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const n of nodes) {
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + n.position.width);
    maxY = Math.max(maxY, n.position.y + n.position.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function findFreeColumn(opts: {
  existing: Rect[];
  anchor: Rect;
  count: number;
  size: { width: number; height: number };
}): Rect[] {
  const blockers = opts.existing;
  let x = opts.anchor.x + opts.anchor.width + GRID_GAP;
  for (;;) {
    const rects: Rect[] = [];
    let y = opts.anchor.y;
    for (let i = 0; i < opts.count; i += 1) {
      rects.push({ x, y, width: opts.size.width, height: opts.size.height });
      y += opts.size.height + GRID_GAP;
    }
    const blocked = rects.some((r) => blockers.some((b) => rectsIntersect(r, b)));
    if (!blocked) return rects;
    x += opts.size.width + GRID_GAP;
  }
}

export function containerChildRects(opts: {
  existing: Rect[];
  count: number;
  startAt?: Rect;
}): Rect[] {
  const blockers = opts.existing;
  const startX = opts.startAt ? opts.startAt.x + opts.startAt.width + GRID_GAP : CONTAINER_PADDING;
  const startY = opts.startAt ? opts.startAt.y : CONTAINER_PADDING;
  let x = startX;
  for (;;) {
    const rects: Rect[] = [];
    let y = startY;
    for (let i = 0; i < opts.count; i += 1) {
      rects.push({ x, y, width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT });
      y += DEFAULT_NODE_HEIGHT + GRID_GAP;
    }
    const blocked = rects.some((r) => blockers.some((b) => rectsIntersect(r, b)));
    if (!blocked) return rects;
    x += DEFAULT_NODE_WIDTH + GRID_GAP;
  }
}

/** Reserve the first free grid slot without moving manually arranged siblings. */
export function agentPosition(
  siblings: Rect[],
  { width, height } = { width: 220, height: 300 },
): Rect {
  const dx = Math.max(width, ...siblings.map((r) => r.width)) + 24;
  const dy = Math.max(height, ...siblings.map((r) => r.height)) + 24;
  const occupied = new Set<number>();
  for (const r of siblings) {
    const first = Math.max(0, Math.floor((r.y - 72 - height) / dy) + 1);
    const last = Math.ceil((r.y + r.height - 72) / dy) - 1;
    for (let col = 0; col < 3; col++) {
      const x = 24 + col * dx;
      if (x >= r.x + r.width || x + width <= r.x) continue;
      for (let row = first; row <= last; row++) occupied.add(row * 3 + col);
    }
  }
  let slot = 0;
  while (occupied.has(slot)) slot++;
  return { x: 24 + (slot % 3) * dx, y: 72 + Math.floor(slot / 3) * dy, width, height };
}
