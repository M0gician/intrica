import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { TurnObserver } from "../../modules/inference/types.js";
import { DomainError } from "../postgres/database.js";
import { PiEvents } from "./pi-events.js";

/** One transport attempt. The inference coordinator owns every retry and history commit. */
export async function streamTurn(
  source: StreamFn,
  model: Model<Api>,
  context: Context,
  options: any,
  progress?: (message: AssistantMessage) => Promise<void>,
  observer?: TurnObserver,
): Promise<AssistantMessage> {
  const transport = new AbortController();
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), transport.signal]);
  const events = new PiEvents(model);
  let idle: ReturnType<typeof setTimeout> | undefined;
  let settling: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (reason: unknown) => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  void cancelled.catch(() => {});
  const abort = () => rejectAbort(signal.reason ?? new Error("运行已停止"));
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(
      () => transport.abort(new DomainError("MODEL_TIMEOUT", "Model request timed out")),
      observer?.idleMs ?? 300_000,
    );
  };
  const cut = () => {
    if (settling) return;
    settling = setTimeout(
      () => transport.abort(new DomainError("EXPEDITED", "加急收尾期限已到")),
      observer!.settleMs,
    );
  };
  signal.addEventListener("abort", abort, { once: true });
  observer?.cutover.addEventListener("abort", cut, { once: true });
  try {
    signal.throwIfAborted();
    await observer?.beforeStart();
    if (observer?.cutover.aborted) cut();
    touch();
    const stream = await Promise.race([
      Promise.resolve(
        source(model, context, {
          ...options,
          signal,
          maxRetries: 0,
          intricaBeforeDispatch: observer?.beforeDispatch,
        } as any),
      ),
      cancelled,
    ]);
    const iterator = stream[Symbol.asyncIterator]();
    for (;;) {
      const next = await Promise.race([iterator.next(), cancelled]);
      if (next.done) throw new Error("Model stream ended without a terminal event");
      touch();
      const event = next.value;
      for (const normalized of events.events(event)) await observer?.event(normalized);
      if (event.type === "error")
        throw new Error(event.error.errorMessage ?? "Model request failed");
      if (event.type === "done") return event.message;
      if ("partial" in event && progress) await progress(structuredClone(event.partial));
    }
  } finally {
    clearTimeout(idle);
    clearTimeout(settling);
    signal.removeEventListener("abort", abort);
    observer?.cutover.removeEventListener("abort", cut);
    transport.abort();
  }
}
