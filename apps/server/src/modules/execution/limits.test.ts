import { expect, it } from "vitest";
import { executionLimits } from "./limits.js";

it("disables the model-turn cap by default and accepts an explicit positive budget", () => {
  expect(executionLimits({}).conversationTurns).toBe(0);
  expect(executionLimits({ INTRICA_CONVERSATION_TURN_LIMIT: "0" }).conversationTurns).toBe(0);
  expect(executionLimits({ INTRICA_CONVERSATION_TURN_LIMIT: "40" }).conversationTurns).toBe(40);
});

it.each(["", " ", "-1", "0.5", "NaN", "Infinity", "9007199254740992"])(
  "rejects invalid model-turn budget %s",
  (value) => expect(() => executionLimits({ INTRICA_CONVERSATION_TURN_LIMIT: value })).toThrow(),
);

it("does not disable concurrency or timeout safeguards when the turn cap is disabled", () => {
  expect(() => executionLimits({ INTRICA_AGENT_CONCURRENCY: "0" })).toThrow();
  expect(() => executionLimits({ INTRICA_TOOL_TIMEOUT_MS: "0" })).toThrow();
  expect(() => executionLimits({ INTRICA_TOOL_TIMEOUT_MS: "30000" })).toThrow();
});
