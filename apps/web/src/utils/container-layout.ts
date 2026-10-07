import type { Rect } from "@intrica/contracts";
import { SpatialIndex } from "../features/canvas/spatial-index";
import { rectsIntersect } from "./geometry";

/** The content origin stays fixed even when children cross the left/top edges. */
export function containerBounds(anchor: Rect, children: Iterable<Rect>): Rect {
  let left = 0,
    top = 0,
    right = 388,
    bottom = 180;
  for (const rect of children) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  return {
    x: anchor.x + left,
    y: anchor.y + top,
    width: right - left + 32,
    height: bottom - top + 80,
  };
}

/** Only repair overlapping content. Preserve deliberately arranged coordinates and card sizes. */
export function containerLayout(
  items: readonly { id: string; position: Rect }[],
  forceGrid = false,
): Map<string, Rect> {
  const index = forceGrid ? null : new SpatialIndex(items);
  const overlap =
    !forceGrid &&
    items.some((item) =>
      index!
        .query(item.position)
        .some((other) => other.id !== item.id && rectsIntersect(item.position, other.position)),
    );
  const outside = items.some((item) => item.position.x < 0 || item.position.y < 0);
  if (!overlap && !outside && !forceGrid)
    return new Map(items.map((item) => [item.id, item.position]));
  const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(items.length))));
  const cellWidth = Math.max(240, ...items.map((item) => item.position.width));
  const cellHeight = Math.max(160, ...items.map((item) => item.position.height));
  return new Map(
    items.map((item, index) => [
      item.id,
      {
        ...item.position,
        x: (index % columns) * (cellWidth + 24),
        y: Math.floor(index / columns) * (cellHeight + 24),
      },
    ]),
  );
}
