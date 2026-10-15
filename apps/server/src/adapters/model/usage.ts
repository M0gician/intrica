import { AsyncLocalStorage } from "node:async_hooks";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { emptyAssistantMessage } from "../../modules/model-runtime/message.js";
import { ModelQueue } from "../../modules/model-runtime/queue.js";
import { scheduledStream } from "../../modules/model-runtime/stream.js";
import { type Database, digest, id } from "../postgres/database.js";
import { modelProgress } from "./progress.js";
import type { FrozenModel } from "./registry.js";

type Scope = {
  db: Database;
  purpose: string;
  validateResponse?: ((message: AssistantMessage) => void) | undefined;
  model: FrozenModel;
  runId?: string | undefined;
  runEpoch?: number | undefined;
  attemptId?: string;
  canvasId?: string;
  conversationId?: string;
  requestId?: string;
  logicalRequestId?: string;
  progress?: (() => void) | undefined;
  suspend?: ((reason: string | null) => Promise<void>) | undefined;
};
const scope = new AsyncLocalStorage<Scope>();
export const withModelUsage = <T>(context: Scope, action: () => T): T => scope.run(context, action);
export const withModelPurpose = <T>(
  purpose: string,
  action: () => T,
  requestId?: string,
  validateResponse?: (message: AssistantMessage) => void,
): T => {
  const current = scope.getStore();
  return current
    ? scope.run(
        {
          ...current,
          purpose,
          validateResponse,
          ...(requestId ? { requestId, logicalRequestId: requestId } : {}),
        },
        action,
      )
    : action();
};
export function modelPurposeRequestId(purpose: string, sourceHash: string) {
  const current = scope.getStore();
  return current
    ? `model-request-${digest([current.runId ?? current.requestId ?? id("request"), current.model, purpose, sourceHash])}`
    : id("model-request");
}
export async function startModelCall() {
  const current = scope.getStore();
  if (!current) return null;
  const callId = id("model-call"),
    config = current.model.config;
  await current.db.pool.query(
    `insert into model_calls(id,run_id,attempt_id,canvas_id,conversation_id,endpoint_id,profile_id,provider,model_id,protocol,purpose,simulated,request_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      callId,
      current.runId,
      current.attemptId,
      current.canvasId,
      current.conversationId,
      current.model.endpointId,
      current.model.profileId,
      config.kind === "mock" ? "intrica-mock" : config.provider,
      config.kind === "mock" ? "mock" : config.modelId,
      config.kind === "mock" ? "mock" : (config.api ?? "default"),
      current.purpose,
      config.kind === "mock",
      current.requestId,
    ],
  );
  return { callId, db: current.db };
}
export async function finishModelCall(
  call: Awaited<ReturnType<typeof startModelCall>>,
  outcome: string,
  message?: AssistantMessage,
) {
  if (!call) return;
  const u = message?.usage;
  const available = Boolean(
    u &&
      [u.input, u.output, u.cacheRead, u.cacheWrite].every((v) => Number.isFinite(v) && v >= 0) &&
      u.input + u.output + u.cacheRead + u.cacheWrite > 0,
  );
  await call.db.pool.query(
    `update model_calls set finished_at=now(),outcome=$2,usage_status=$3,input_tokens=$4,output_tokens=$5,cache_read_tokens=$6,cache_write_tokens=$7,response_id=$8 where id=$1 and finished_at is null`,
    [
      call.callId,
      outcome,
      available ? "reported" : "unavailable",
      available ? u!.input + u!.cacheRead + u!.cacheWrite : null,
      available ? u!.output : null,
      available ? u!.cacheRead : null,
      available ? u!.cacheWrite : null,
      message?.responseId?.slice(0, 200) ?? null,
    ],
  );
}
/** Inside the retry wrapper: one ledger row per observable provider attempt. */
export function meteredStream(source: StreamFn): StreamFn {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      let call: Awaited<ReturnType<typeof startModelCall>> = null;
      let progress = modelProgress(null);
      let partial: AssistantMessage = emptyAssistantMessage(model);
      let rejectAbort: (error: Error) => void = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        rejectAbort = reject;
      });
      // Attach the rejection handler before initialization can yield.
      void cancelled.catch(() => {});
      const stop = () => rejectAbort(new Error("Model request aborted"));
      options?.signal?.addEventListener("abort", stop, { once: true });
      try {
        call = await startModelCall();
        progress = modelProgress(call);
        if (options?.signal?.aborted) throw new Error("Model request aborted");
        const stream = await Promise.race([
          Promise.resolve(
            source(model, context, {
              ...options,
              onResponse: async (response, responseModel) => {
                const headers = Object.fromEntries(
                  Object.entries(response.headers).map(([k, v]) => [k.toLowerCase(), v]),
                );
                const requestId =
                  headers["x-request-id"] ?? headers["request-id"] ?? headers["x-amzn-requestid"];
                if (call)
                  await call.db.pool.query(
                    "update model_calls set provider_request_id=$2,first_response_at=coalesce(first_response_at,now()) where id=$1",
                    [
                      call.callId,
                      requestId && /^[\w.:/-]{1,200}$/.test(requestId) ? requestId : null,
                    ],
                  );
                await progress.observe("response");
                await options?.onResponse?.(response, responseModel);
              },
            }),
          ),
          cancelled,
        ]);
        const iterator = stream[Symbol.asyncIterator]();
        for (;;) {
          const event = await Promise.race([iterator.next(), cancelled]);
          if (event.done) throw new Error("Model stream ended without result");
          const value = event.value;
          if (value.type !== "start" && value.type !== "error") await progress.observe(value.type);
          if (value.type === "done" || value.type === "error") {
            partial = value.type === "done" ? value.message : value.error;
            await progress.flush();
            await finishModelCall(
              call,
              value.type === "done" ? "succeeded" : value.reason,
              partial,
            );
            output.push(value);
            return;
          }
          partial = value.partial;
          output.push(value);
        }
      } catch (error) {
        const reason = options?.signal?.aborted ? "aborted" : "error";
        await progress.flush().catch(() => {});
        await finishModelCall(call, reason, partial).catch(() => {});
        output.push({
          type: "error",
          reason,
          error: {
            ...partial,
            stopReason: reason,
            errorMessage:
              error instanceof Error &&
              /timeout|timed out|etimedout|\b408\b|\b504\b/i.test(error.message)
                ? "Model request timed out"
                : error instanceof Error
                  ? error.message
                  : "Model request failed or was interrupted",
          },
        });
      } finally {
        options?.signal?.removeEventListener("abort", stop);
      }
    })();
    return output;
  };
}

/** Scheduling wraps metering so each network attempt has one receipt. */
export function modelStream(source: StreamFn): StreamFn {
  return (model, context, options) => {
    const current = scope.getStore();
    if (!current) return scheduledStream(meteredStream(source), {})(model, context, options);
    const frozen = JSON.parse(
      JSON.stringify({
        ...context,
        messages: context.messages.map(({ timestamp: _timestamp, ...message }) => message),
      }),
    );
    const sourceHash = digest([model, frozen, current.model.credentialRef]);
    const requestId =
      current.logicalRequestId ??
      `model-request-${digest([current.runId ?? current.requestId ?? id("request"), current.purpose, sourceHash])}`;
    const queue = new ModelQueue(current.db, {
      id: requestId,
      runId: current.runId,
      runEpoch: current.runEpoch,
      conversationId: current.conversationId ?? current.runId ?? requestId,
      purpose: current.purpose,
      endpointId: current.model.endpointId,
      endpointKey: model.baseUrl,
      sourceHash,
    });
    return scope.run({ ...current, requestId }, () =>
      scheduledStream(meteredStream(source), {
        queue,
        progress: current.progress,
        suspend: current.suspend,
        validate: current.validateResponse,
      })(model, context, options),
    );
  };
}
