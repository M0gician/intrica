import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";

/** Retry only inference, keeping completed tool calls outside the retry boundary. */
export function retryTimedOutRequests(
  source: StreamFn,
  { idleMs = 300_000, retryDelayMs = 1000, retries = 2 } = {},
): StreamFn {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      let started = false;
      let partial: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: "error",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      for (let attempt = 0; ; attempt++) {
        const abort = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        let rejectAbort: (error: Error) => void = () => {};
        const interrupted = new Promise<never>((_, reject) => {
          rejectAbort = reject;
        });
        // The provider may ignore cancellation; every awaited network step also races this promise.
        const cancel = () => {
          abort.abort();
          rejectAbort(new Error("Request aborted"));
        };
        const touch = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            timedOut = true;
            abort.abort();
            rejectAbort(new Error("Model request timed out"));
          }, idleMs);
        };
        options?.signal?.addEventListener("abort", cancel, { once: true });
        let failure = "";
        try {
          touch();
          if (options?.signal?.aborted) cancel();
          const stream = await Promise.race([
            Promise.resolve(source(model, context, { ...options, signal: abort.signal })),
            interrupted,
          ]);
          const iterator = stream[Symbol.asyncIterator]();
          for (;;) {
            const next = await Promise.race([iterator.next(), interrupted]);
            if (next.done) throw new Error("Model stream ended without a terminal event");
            touch();
            const event = next.value;
            if (event.type === "error") {
              partial = event.error;
              throw new Error(event.error.errorMessage ?? "Model request failed");
            }
            if (event.type === "done") {
              output.push(event);
              return;
            }
            partial = event.partial;
            if (event.type === "start" && started) {
              // Reset the one in-flight message; another start would append a phantom turn in PI.
              output.push({ type: "text_delta", contentIndex: 0, delta: "", partial });
            } else {
              output.push(event);
              if (event.type === "start") started = true;
            }
          }
        } catch (error) {
          failure = timedOut
            ? "Model request timed out"
            : error instanceof Error
              ? error.message
              : String(error);
        } finally {
          clearTimeout(timer);
          options?.signal?.removeEventListener("abort", cancel);
          abort.abort();
        }
        const stopped = options?.signal?.aborted;
        if (
          stopped ||
          attempt >= retries ||
          !/timeout|timed out|etimedout|\b408\b|\b504\b/i.test(failure)
        ) {
          const reason = stopped ? "aborted" : "error";
          output.push({
            type: "error",
            reason,
            error: { ...partial, stopReason: reason, errorMessage: failure },
          });
          return;
        }
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(delay);
            options?.signal?.removeEventListener("abort", finish);
            resolve();
          };
          const delay = setTimeout(finish, retryDelayMs * (attempt + 1));
          options?.signal?.addEventListener("abort", finish, { once: true });
          if (options?.signal?.aborted) finish();
        });
      }
    })();
    return output;
  };
}
