import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { classifyModelFailure, retryDelay } from "./errors.js";
import type { ModelQueue } from "./queue.js";

type Options = {
  validate?: ((message: AssistantMessage) => void) | undefined;
  queue?: ModelQueue;
  signal?: AbortSignal;
  progress?: (() => void) | undefined;
  suspend?: ((reason: string | null) => Promise<void>) | undefined;
  idleMs?: number;
  retryWindowMs?: number;
};
const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });

/** One retry owner for all model purposes. Completed responses are cached before delivery. */
export function scheduledStream(source: StreamFn, runtime: Options): StreamFn {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      const signal = options?.signal ?? runtime.signal,
        queue = runtime.queue;
      let owner: string | null = null,
        started = false;
      let partial: AssistantMessage = {
        role: "assistant",
        content: [],
        model: model.id,
        provider: model.provider,
        api: model.api,
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
      try {
        const group = await queue?.initialize();
        for (;;) {
          signal?.throwIfAborted();
          const admission = queue ? await queue.admit(group!, runtime.retryWindowMs) : null;
          if (admission?.row.state === "succeeded") {
            output.push({
              type: "done",
              reason: admission.row.response.stopReason,
              message: admission.row.response,
            });
            return;
          }
          if (admission && ["failed", "cancelled"].includes(admission.row.state))
            throw new Error(
              `${admission.row.reason}: Model request needs attention / 模型请求需要处理`,
            );
          owner = admission?.owner ?? null;
          if (queue && !owner) {
            await runtime.suspend?.(
              admission?.row.state === "retry_wait" ? "model_retry" : "model_queued",
            );
            runtime.progress?.();
            await pause(500, signal);
            continue;
          }
          await runtime.suspend?.(null);
          const abort = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          let reject: (err: Error) => void = () => {};
          const interrupted = new Promise<never>((_, fail) => {
            reject = fail;
          });
          void interrupted.catch(() => {});
          const cancel = () => {
            abort.abort();
            reject(new Error("Model request aborted"));
          };
          const touch = () => {
            clearTimeout(timer);
            runtime.progress?.();
            timer = setTimeout(() => {
              abort.abort();
              reject(new Error("Model request timed out"));
            }, runtime.idleMs ?? 300000);
          };
          let headers: Record<string, string> = {},
            status: number | undefined;
          signal?.addEventListener("abort", cancel, { once: true });
          const renew =
            queue && owner
              ? setInterval(() => {
                  void queue.renew(owner!).catch((error) => {
                    abort.abort();
                    reject(error);
                  });
                }, 10000)
              : undefined;
          try {
            touch();
            const stream = await Promise.race([
              Promise.resolve(
                source(model, context, {
                  ...options,
                  signal: abort.signal,
                  onResponse: async (response, responseModel) => {
                    headers = Object.fromEntries(
                      Object.entries(response.headers).map(([k, v]) => [k.toLowerCase(), v]),
                    );
                    status = response.status;
                    await options?.onResponse?.(response, responseModel);
                  },
                }),
              ),
              interrupted,
            ]);
            const iterator = stream[Symbol.asyncIterator]();
            for (;;) {
              const next = await Promise.race([iterator.next(), interrupted]);
              if (next.done) throw new Error("Network stream ended before completion");
              touch();
              const event = next.value;
              if (event.type === "error")
                throw new Error(event.error.errorMessage ?? "Model request failed");
              if (event.type === "done") {
                signal?.throwIfAborted();
                runtime.validate?.(event.message);
                if (queue) await queue.succeed(owner!, event.message);
                output.push(event);
                return;
              }
              partial = event.partial;
              if (event.type === "start" && started)
                output.push({ type: "text_delta", contentIndex: 0, delta: "", partial });
              else {
                output.push(event);
                if (event.type === "start") started = true;
              }
            }
          } catch (error) {
            if (signal?.aborted) throw error;
            const failure = classifyModelFailure(
              error instanceof Error ? error.message : String(error),
              status,
            );
            const delay = retryDelay(admission?.row.attempts ?? 1, headers["retry-after"]);
            const validationLimit =
              failure.code === "CONTEXT_SUMMARY_INVALID" && (admission?.row.attempts ?? 1) >= 3;
            const retry = Boolean(
              queue &&
                failure.retryable &&
                !validationLimit &&
                Date.now() +
                  delay -
                  new Date(admission!.row.first_failure_at ?? Date.now()).getTime() <
                  (runtime.retryWindowMs ?? 600000),
            );
            if (queue)
              await queue.retry(
                owner!,
                failure,
                delay,
                retry,
                failure.code === "MODEL_TIMEOUT" || failure.code === "MODEL_NETWORK",
              );
            if (!retry)
              throw new Error(
                `${failure.code}: ${failure.message}${validationLimit ? " — summary validation failed after 3 attempts / 摘要校验连续 3 次失败" : queue && failure.retryable ? " — automatic retry window ended / 自动重试窗口已结束" : ""}`,
              );
          } finally {
            clearTimeout(timer);
            clearInterval(renew);
            abort.abort();
            signal?.removeEventListener("abort", cancel);
          }
        }
      } catch (error) {
        if (signal?.aborted) await queue?.cancel(owner).catch(() => {});
        const reason = signal?.aborted ? "aborted" : "error";
        output.push({
          type: "error",
          reason,
          error: {
            ...partial,
            stopReason: reason,
            errorMessage: signal?.aborted
              ? "Model request cancelled / 模型请求已取消"
              : error instanceof Error
                ? error.message
                : "Model request failed / 模型请求失败",
          },
        });
      } finally {
        await runtime.suspend?.(null).catch(() => {});
      }
    })();
    return output;
  };
}
