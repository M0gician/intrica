import { expect, it } from "vitest";
import { normalizeModelProfile } from "./model-settings.js";

const profile = {
  name: "Local",
  provider: "custom",
  api: "openai-completions" as const,
  modelId: "test",
  baseUrl: "http://localhost:11434/v1",
  thinkingLevel: "high" as const,
  reasoning: true,
  supportsVision: false,
};
it("normalizes model fields and validates capability and output budgets", () => {
  expect(
    normalizeModelProfile({ ...profile, modelId: "  test  ", contextWindow: 65536 }),
  ).toMatchObject({ modelId: "test", contextWindow: 65536 });
  expect(() => normalizeModelProfile({ ...profile, contextWindow: 100 })).toThrow();
  expect(() =>
    normalizeModelProfile({ ...profile, contextWindow: 4096, maxOutputTokens: 8192 }),
  ).toThrow();
  expect(() => normalizeModelProfile({ ...profile, reasoning: false })).toThrow();
  expect(() =>
    normalizeModelProfile({ ...profile, baseUrl: "https://user:secret@example.com" }),
  ).toThrow();
});
