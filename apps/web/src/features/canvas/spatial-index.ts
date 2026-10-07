import type { Rect } from "@intrica/contracts";
export function intersects(a: Rect, b: Rect) {
  return (
    a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y
  );
}
/** Rebuildable uniform grid. Oversized objects stay in one overflow bucket. */
export class SpatialIndex<T extends { id: string; position: Rect }> {
  private cells = new Map<string, T[]>();
  private overflow: T[] = [];
  constructor(
    readonly items: readonly T[],
    readonly cellSize = 512,
  ) {
    for (const item of items) {
      const keys = this.keys(item.position);
      if (!keys) this.overflow.push(item);
      else
        for (const key of keys) {
          const cell = this.cells.get(key) ?? [];
          cell.push(item);
          this.cells.set(key, cell);
        }
    }
  }
  private keys(rect: Rect): string[] | null {
    const left = Math.floor(rect.x / this.cellSize),
      top = Math.floor(rect.y / this.cellSize);
    const right = Math.floor((rect.x + rect.width) / this.cellSize),
      bottom = Math.floor((rect.y + rect.height) / this.cellSize);
    if ((right - left + 1) * (bottom - top + 1) > 4096) return null;
    const keys = [];
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) keys.push(`${x}:${y}`);
    return keys;
  }
  query(rect: Rect): T[] {
    const keys = this.keys(rect);
    if (!keys) return this.items.filter((item) => intersects(item.position, rect));
    const found = new Map<string, T>();
    for (const item of this.overflow) if (intersects(item.position, rect)) found.set(item.id, item);
    for (const key of keys)
      for (const item of this.cells.get(key) ?? [])
        if (!found.has(item.id) && intersects(item.position, rect)) found.set(item.id, item);
    return [...found.values()];
  }
}
