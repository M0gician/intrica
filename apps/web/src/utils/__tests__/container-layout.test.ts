import { describe, expect, it } from "vitest";
import { containerLayout } from "../container-layout";

describe("containerLayout", () => {
  it("keeps deliberately arranged children in place", () => {
    const result = containerLayout([
      { id: "a", position: { x: 10, y: 20, width: 100, height: 60 } },
      { id: "b", position: { x: 140, y: 20, width: 100, height: 60 } },
    ]);
    expect(result.get("a")?.x).toBe(10);
    expect(result.get("b")?.x).toBe(140);
  });

  it("lays overlapping children into separate columns", () => {
    const result = containerLayout([
      { id: "a", position: { x: 0, y: 0, width: 200, height: 100 } },
      { id: "b", position: { x: 0, y: 0, width: 200, height: 100 } },
    ]);
    expect(result.get("a")?.x).not.toBe(result.get("b")?.x);
  });
});
