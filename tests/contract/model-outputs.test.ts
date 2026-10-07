import { modelOutputFixtures } from "@intrica/tests-fixtures";
import { describe, expect, it } from "vitest";

describe("模型输出 fixtures 的形状（PRD §7.2）", () => {
  it("压缩恰好包含 1 个 items 项", () => {
    expect(modelOutputFixtures.compress.items).toHaveLength(1);
  });

  it("展开与深化至少包含 1 个 items 项", () => {
    expect(modelOutputFixtures.expand.items.length).toBeGreaterThanOrEqual(1);
    expect(modelOutputFixtures.deepen.items.length).toBeGreaterThanOrEqual(1);
  });

  it("每个 items 项都带非空 title 与 text（模型只返回结构化文本）", () => {
    for (const output of Object.values(modelOutputFixtures)) {
      for (const item of output.items) {
        expect(typeof item.title).toBe("string");
        expect(item.title.length).toBeGreaterThan(0);
        expect(typeof item.text).toBe("string");
        expect(item.text.length).toBeGreaterThan(0);
      }
    }
  });
});
