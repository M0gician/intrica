import { describe, expect, it } from "vitest";
import { agentNamePool, nextAgentName } from "./agent-names.js";

describe("generated Agent names", () => {
  it.each(["zh-CN", "en", "ja", "zh-TW"])(
    "keeps %s names unique after exhausting the pool",
    (language) => {
      const pool = agentNamePool(language);
      const names: string[] = [];
      for (let i = 0; i < pool.length * 3; i++) {
        const next = nextAgentName(names, language, () => (i % 10) / 10);
        expect(next).not.toBe("");
        expect(names).not.toContain(next);
        expect(pool).toContain(next.replace(/ \d+$/, ""));
        names.push(next);
      }
      expect(new Set(names).size).toBe(names.length);
    },
  );
  it("uses a random start, recognizes reserved names and has an English fallback", () => {
    const first = nextAgentName([], "en", () => 0);
    expect(nextAgentName([], "en", () => 0.9)).not.toBe(first);
    expect(nextAgentName([first], "en", () => 0)).not.toBe(first);
    expect(nextAgentName([], "unknown", () => 0)).toBe(first);
  });
});
