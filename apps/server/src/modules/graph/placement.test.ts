import { expect, it } from "vitest";
import { agentPosition } from "./placement.js";

it("places new members without intersecting irregular or manually positioned siblings", () => {
  const siblings = [
    { x: -30, y: -40, width: 560, height: 480 },
    { x: 730, y: 300, width: 260, height: 200 },
  ];
  const original = structuredClone(siblings);
  for (let i = 0; i < 65; i++) {
    const next = agentPosition(siblings);
    expect(
      siblings.every(
        (r) =>
          next.x + next.width <= r.x ||
          r.x + r.width <= next.x ||
          next.y + next.height <= r.y ||
          r.y + r.height <= next.y,
      ),
    ).toBe(true);
    siblings.push(next);
  }
  expect(siblings.slice(0, 2)).toEqual(original);
});
