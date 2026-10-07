import type { Rect } from "@intrica/contracts";
export type ConnectionAnchor = { x: number; y: number; side: "left" | "right" | "top" | "bottom" };
/** Screen-space tolerance stays usable at different canvas zoom levels. Output uses fractions. */
export function connectionAnchor(
  rect: Rect,
  point: { x: number; y: number },
  tolerance = 14,
): ConnectionAnchor | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = point.x - rect.x,
    y = point.y - rect.y;
  if (x < -tolerance || x > rect.width + tolerance || y < -tolerance || y > rect.height + tolerance)
    return null;
  const sides = [
    { side: "left", distance: Math.abs(x) },
    { side: "right", distance: Math.abs(rect.width - x) },
    { side: "top", distance: Math.abs(y) },
    { side: "bottom", distance: Math.abs(rect.height - y) },
  ] as const;
  const closest = [...sides].sort((a, b) => a.distance - b.distance)[0]!;
  if (closest.distance > tolerance) return null;
  const inset = Math.min(18, rect.width / 4, rect.height / 4);
  const cx = Math.max(inset, Math.min(rect.width - inset, x)) / rect.width;
  const cy = Math.max(inset, Math.min(rect.height - inset, y)) / rect.height;
  return {
    side: closest.side,
    x: closest.side === "left" ? 0 : closest.side === "right" ? 1 : cx,
    y: closest.side === "top" ? 0 : closest.side === "bottom" ? 1 : cy,
  };
}
