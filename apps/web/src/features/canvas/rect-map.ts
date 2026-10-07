import type { Rect } from "@intrica/contracts";

/** Geometry overlays retain the committed map and calculate only queried rectangles. */
export class RectMap implements ReadonlyMap<string, Rect> {
  readonly [Symbol.toStringTag] = "RectMap";
  constructor(
    private readonly base: ReadonlyMap<string, Rect>,
    private readonly project: (id: string, rect: Rect) => Rect,
  ) {}
  get size() {
    return this.base.size;
  }
  has(id: string) {
    return this.base.has(id);
  }
  get(id: string) {
    const rect = this.base.get(id);
    return rect && this.project(id, rect);
  }
  keys() {
    return this.base.keys();
  }
  *values(): MapIterator<Rect> {
    for (const [id, rect] of this.base) yield this.project(id, rect);
  }
  *entries(): MapIterator<[string, Rect]> {
    for (const [id, rect] of this.base) yield [id, this.project(id, rect)];
  }
  [Symbol.iterator]() {
    return this.entries();
  }
  forEach(
    callback: (value: Rect, key: string, map: ReadonlyMap<string, Rect>) => void,
    thisArg?: unknown,
  ) {
    for (const [id, rect] of this) callback.call(thisArg, rect, id, this);
  }
}
