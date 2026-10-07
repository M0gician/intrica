import { describe, expect, it } from "vitest";
import { nextAgentName } from "../agent-names";
import { connectionAnchor } from "../connection-anchor";

describe("证据卡交互", () => {
  it("生成姓名不重名，并使用随机起点", () => {
    const names: string[] = [];
    for (let i = 0; i < 24; i++) names.push(nextAgentName(names));
    expect(new Set(names).size).toBe(24);
    expect(names.length).toBe(24);
    expect(nextAgentName([], () => 0.99)).not.toBe(nextAgentName([], () => 0));
    expect(names[0]).not.toBe("新 Agent");
    for (let i = 0; i < 20; i++) names.push(nextAgentName(names));
    expect(new Set(names).size).toBe(44);
  });
  it("靠近四条边才出现连接点，中心与远处不出现", () => {
    const rect = { x: 100, y: 100, width: 240, height: 160 };
    expect(connectionAnchor(rect, { x: 101, y: 180 })?.side).toBe("left");
    expect(connectionAnchor(rect, { x: 339, y: 180 })?.side).toBe("right");
    expect(connectionAnchor(rect, { x: 220, y: 101 })?.side).toBe("top");
    expect(connectionAnchor(rect, { x: 220, y: 259 })?.side).toBe("bottom");
    expect(connectionAnchor(rect, { x: 220, y: 180 })).toBeNull();
    expect(connectionAnchor(rect, { x: 70, y: 180 })).toBeNull();
  });
  it("缩放后仍使用屏幕距离判断，并避开尖角", () => {
    const rect = { x: 20, y: 20, width: 120, height: 80 };
    expect(connectionAnchor(rect, { x: 32, y: 60 })?.side).toBe("left");
    expect(connectionAnchor(rect, { x: 36, y: 60 })).toBeNull();
    const corner = connectionAnchor(rect, { x: 20, y: 20 })!;
    expect(corner.y).toBeCloseTo(18 / 80);
  });
});
