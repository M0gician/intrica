import type { Rect } from "@intrica/contracts";
import { type RefObject, useEffect, useMemo, useState } from "react";
import { intersects, SpatialIndex } from "./spatial-index";
export function useViewport(
  ref: RefObject<HTMLElement | null>,
  pan: { x: number; y: number },
  zoom: number,
): Rect {
  const [size, setSize] = useState({
    width: window.innerWidth || 1280,
    height: window.innerHeight || 800,
  });
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);
  return {
    x: (-pan.x - 240) / zoom,
    y: (-pan.y - 240) / zoom,
    width: (size.width + 480) / zoom,
    height: (size.height + 480) / zoom,
  };
}
type SceneMotion = {
  ids: ReadonlySet<string>;
  delta: { x: number; y: number };
};
export function useVisibleScene<T extends { id: string; position: Rect }>(
  items: readonly T[],
  bounds: Rect,
  pinned: ReadonlySet<string>,
  layout?: ReadonlyMap<string, Rect>,
  motion?: SceneMotion,
): T[] {
  const index = useMemo(
    () =>
      new SpatialIndex(
        items.map((item) => ({ id: item.id, position: layout?.get(item.id) ?? item.position })),
      ),
    [items, layout],
  );
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const order = useMemo(() => new Map(items.map((item, index) => [item.id, index])), [items]);
  const candidates = index.query(bounds);
  if (motion)
    candidates.push(
      ...index.query({ ...bounds, x: bounds.x - motion.delta.x, y: bounds.y - motion.delta.y }),
    );
  const ids = new Set(pinned);
  for (const item of candidates) {
    const position = motion?.ids.has(item.id)
      ? {
          ...item.position,
          x: item.position.x + motion.delta.x,
          y: item.position.y + motion.delta.y,
        }
      : item.position;
    if (intersects(position, bounds)) ids.add(item.id);
  }
  return [...ids]
    .sort((a, b) => order.get(a)! - order.get(b)!)
    .flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
}
