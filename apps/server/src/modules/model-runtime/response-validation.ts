import { createHash } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Only service-authored diagnostics belong here; never include provider prose. */
export class ResponseValidationError extends Error {
  readonly code = "CONTEXT_SUMMARY_INVALID";
  constructor(
    readonly issue: string,
    readonly correction?: string,
  ) {
    super(`CONTEXT_SUMMARY_INVALID: ${issue}`);
  }
}

export type ResponseValidation = {
  status: "accepted" | "rejected";
  issue: string | null;
  stopReason: string;
  outputChars: number;
  outputHash: string;
  outputExcerpt: string;
  outputTruncated: boolean;
};

export function validationReceipt(message: AssistantMessage, error?: unknown): ResponseValidation {
  const text = message.content
    .flatMap((part) =>
      part.type === "text" ? [part.text] : part.type === "toolCall" ? [JSON.stringify(part)] : [],
    )
    .join("\n");
  return {
    status: error === undefined ? "accepted" : "rejected",
    issue:
      error === undefined
        ? null
        : error instanceof ResponseValidationError
          ? error.issue
          : "invalid_response",
    stopReason: message.stopReason,
    outputChars: text.length,
    outputHash: createHash("sha256").update(text).digest("hex"),
    outputExcerpt: text.slice(0, 16000),
    outputTruncated: text.length > 16000,
  };
}

/** A correction replaces only the generated response, never its frozen source. */
export function responseCorrection(error: unknown): string | null {
  return error instanceof ResponseValidationError ? (error.correction ?? null) : null;
}
