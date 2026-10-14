import { expect, it } from "vitest";
import { DomainError } from "../../adapters/postgres/database.js";
import { contextFailure } from "../context/errors.js";
import { failureReason } from "./run-notices.js";

it.each(["en", "zh-CN"] as const)(
  "preserves actionable context failures through stream error conversion (%s)",
  (language) => {
    for (const code of [
      "CONTEXT_EMPTY_SOURCE",
      "CONTEXT_COMPACTION_LIMIT",
      "INSTRUCTION_CONTEXT_LIMIT",
    ] as const) {
      const error = contextFailure(code, language);
      expect(failureReason(error)).toBe(error.message);
      expect(failureReason(new Error(error.message))).toBe(error.message);
      expect(error.message).toContain(language === "en" ? "preserved" : "保留");
    }
  },
);

it("retains summary validation failures rather than blaming the endpoint", () => {
  const reason =
    "CONTEXT_SUMMARY_INVALID: Summary rejected / 摘要无效 — summary validation failed after 3 attempts / 摘要校验连续 3 次失败";
  expect(failureReason(new Error(reason))).toBe(reason);
  expect(failureReason(new DomainError("CONTEXT_SUMMARY_INVALID", reason))).toBe(reason);
  expect(failureReason(new Error("PRIVATE_PROVIDER_PAYLOAD"))).not.toContain(
    "PRIVATE_PROVIDER_PAYLOAD",
  );
});
