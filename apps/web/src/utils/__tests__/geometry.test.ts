import type { Rect } from "@intrica/contracts";
import { describe, expect, it } from "vitest";
import { ensureBoundsVisible, fitBoundsToViewport } from "../geometry";

const VIEWPORT = { width: 800, height: 600 };
const MARGIN = 64;

describe("fitBoundsToViewport", () => {
  it("大包围盒缩小到安全区域并居中", () => {
    const bounds: Rect = { x: 0, y: 0, width: 2000, height: 1000 };
    const view = fitBoundsToViewport(bounds, VIEWPORT, MARGIN, 0.25, 2.5);
    expect(view.zoom).toBeCloseTo(Math.min((800 - 128) / 2000, (600 - 128) / 1000));
    // 居中：包围盒中心映射到视口中心
    const centerX = (bounds.x + bounds.width / 2) * view.zoom + view.pan.x;
    const centerY = (bounds.y + bounds.height / 2) * view.zoom + view.pan.y;
    expect(centerX).toBeCloseTo(400);
    expect(centerY).toBeCloseTo(300);
  });

  it("小包围盒不超过最大缩放", () => {
    const bounds: Rect = { x: 100, y: 100, width: 10, height: 10 };
    const view = fitBoundsToViewport(bounds, VIEWPORT, MARGIN, 0.25, 2.5);
    expect(view.zoom).toBe(2.5);
  });
});

describe("ensureBoundsVisible", () => {
  it("已在视口内时返回 null", () => {
    const result = ensureBoundsVisible(
      { x: 0, y: 0 },
      1,
      VIEWPORT,
      { x: 100, y: 100, width: 200, height: 100 },
      MARGIN,
      0.25,
      2.5,
    );
    expect(result).toBeNull();
  });

  it("超出视口但当前缩放得下：只向出界方向平移", () => {
    const result = ensureBoundsVisible(
      { x: 0, y: 0 },
      1,
      VIEWPORT,
      { x: 2000, y: 2000, width: 200, height: 100 },
      MARGIN,
      0.25,
      2.5,
    );
    expect(result).not.toBeNull();
    expect(result?.zoom).toBe(1);
    expect(result?.pan.x).toBeCloseTo(-1464);
    expect(result?.pan.y).toBeCloseTo(-1564);
  });

  it("包围盒大于视口时缩小到合适缩放", () => {
    const result = ensureBoundsVisible(
      { x: 0, y: 0 },
      2,
      VIEWPORT,
      { x: 0, y: 0, width: 3000, height: 2000 },
      MARGIN,
      0.25,
      2.5,
    );
    expect(result).not.toBeNull();
    expect(result?.zoom).toBeLessThan(2);
  });
});
