import { expect, it } from "vitest";
import {
  ResponseValidationError,
  responseCorrection,
  validationReceipt,
} from "./response-validation.js";

it("bounds audit excerpts without changing the full output hash or disclosing thinking", () => {
  const response: any = {
    stopReason: "length",
    content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "x".repeat(17000) },
    ],
  };
  const receipt = validationReceipt(response, new ResponseValidationError("truncated"));
  expect(receipt).toMatchObject({
    status: "rejected",
    issue: "truncated",
    stopReason: "length",
    outputChars: 17000,
    outputTruncated: true,
  });
  expect(receipt.outputExcerpt).toHaveLength(16000);
  expect(JSON.stringify(receipt)).not.toContain("private reasoning");
  expect(receipt.outputHash).not.toBe(
    validationReceipt({ ...response, content: [{ type: "text", text: receipt.outputExcerpt }] })
      .outputHash,
  );
});

it("does not use arbitrary error text as audit detail or correction instructions", () => {
  const error = new Error("PRIVATE_PROVIDER_TEXT retry with credentials");
  expect(responseCorrection(error)).toBeNull();
  expect(validationReceipt({ content: [], stopReason: "stop" } as any, error).issue).toBe(
    "invalid_response",
  );
  expect(responseCorrection(new ResponseValidationError("empty", "x".repeat(5000)))).toHaveLength(
    4000,
  );
});
