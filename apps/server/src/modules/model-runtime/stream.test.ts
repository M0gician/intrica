import { expect, it, vi } from "vitest";
import { scheduledStream } from "./stream.js";

it("does not dispatch when cancellation arrives during admission bookkeeping", async () => {
  const abort = new AbortController();
  const source = vi.fn();
  const stream = await scheduledStream(source, {
    signal: abort.signal,
    suspend: async () => {
      abort.abort();
    },
  })({ id: "test", provider: "custom", api: "openai-completions" } as any, { messages: [] });
  const result = await stream.result();
  expect(source).not.toHaveBeenCalled();
  expect(result.stopReason).toBe("aborted");
});
