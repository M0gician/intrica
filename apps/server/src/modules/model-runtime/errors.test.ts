import { expect, it } from "vitest";
import { classifyModelFailure, retryDelay } from "./errors.js";

it.each([
  ["quota_exceeded: concurrent limit=10 used=10", "MODEL_CAPACITY", true],
  ["quota_exceeded: insufficient balance", "MODEL_BALANCE", false],
  ["engine_overloaded", "MODEL_OVERLOADED", true],
  ["429 too many requests", "MODEL_RATE_LIMIT", true],
  ["401 invalid api key PRIVATE_KEY", "MODEL_AUTH", false],
  ["ETIMEDOUT", "MODEL_TIMEOUT", true],
  ["ECONNRESET", "MODEL_NETWORK", true],
  ["quota_exceeded: unexplained", "MODEL_CONFIGURATION", false],
  ["role 'developer' is not allowed", "MODEL_ROLE_UNSUPPORTED", false],
  ["CONTEXT_SUMMARY_INVALID: rejected", "CONTEXT_SUMMARY_INVALID", false],
] as const)("classifies %s safely", (raw, code, retryable) => {
  const result = classifyModelFailure(raw);
  expect(result).toMatchObject({ code, retryable });
  expect(result.message).not.toContain("PRIVATE_KEY");
});
it("respects Retry-After and caps jittered exponential fallback", () => {
  expect(retryDelay(1, "120", 0)).toBe(120000);
  expect(retryDelay(1, new Date(30000).toUTCString(), 0)).toBe(30000);
  expect(retryDelay(99, undefined, 0, () => 1)).toBe(60000);
  expect(retryDelay(1, "invalid", 0, () => 0)).toBe(750);
});
