import { AsyncLocalStorage } from "node:async_hooks";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { providerHistory } from "../../modules/inference/context-projection.js";
import type { InferenceIdentity } from "../../modules/inference/types.js";
import { type Database, id } from "../postgres/database.js";
import { ModelDiagnostics } from "./diagnostic-manifest.js";
import type { FrozenModel } from "./registry.js";

type Scope = {
  db: Database;
  purpose: string;
  model: FrozenModel;
  runId?: string;
  attemptId?: string;
  canvasId?: string;
  conversationId?: string;
  requestId?: string;
  generationId?: string;
  workItemId?: string | undefined;
  inference?: InferenceIdentity;
};
const scope = new AsyncLocalStorage<Scope>();
export const withModelUsage = <T>(context: Scope, action: () => T): T => scope.run(context, action);
export const withModelPurpose = <T>(purpose: string, action: () => T): T => {
  const current = scope.getStore();
  return current ? scope.run({ ...current, purpose }, action) : action();
};
export const withInferenceAttempt = <T>(inference: InferenceIdentity, action: () => T): T => {
  const current = scope.getStore();
  return current
    ? scope.run(
        {
          ...current,
          inference,
          generationId: inference.requestId,
          workItemId: inference.workItemId,
        },
        action,
      )
    : action();
};
export const withModelTurn = <T>(
  generationId: string,
  workItemId: string | undefined,
  action: () => T,
): T => {
  const current = scope.getStore();
  return current ? scope.run({ ...current, generationId, workItemId }, action) : action();
};
export async function startModelCall() {
  const current = scope.getStore();
  if (!current) return null;
  const callId = id("model-call"),
    config = current.model.config;
  await current.db.pool.query(
    `insert into model_calls(id,run_id,attempt_id,canvas_id,conversation_id,endpoint_id,profile_id,provider,model_id,protocol,purpose,simulated,request_id,generation_id,work_item_id,inference_attempt_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
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
      current.generationId,
      current.workItemId,
      current.inference?.attemptId ?? null,
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
/** One ledger row per transport attempt. Retries belong to the inference coordinator. */
export function meteredStream(source: StreamFn): StreamFn {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      let call: Awaited<ReturnType<typeof startModelCall>> = null;
      let diagnostics: ModelDiagnostics | undefined;
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
        const projected = {
          ...context,
          messages: providerHistory(context.messages, model, true) as typeof context.messages,
        };
        if (call)
          diagnostics = await ModelDiagnostics.start(call.db, call.callId, projected, model, {
            contextSeq: scope.getStore()?.inference?.contextSeq,
            ...(scope.getStore()?.conversationId
              ? { conversationId: scope.getStore()!.conversationId! }
              : {}),
            ...(options?.apiKey ? { apiKey: options.apiKey } : {}),
            publicOptions: Object.fromEntries(
              ["temperature", "maxTokens", "reasoning", "cacheRetention", "thinkingBudgets"]
                .filter((key) => options && (options as any)[key] !== undefined)
                .map((key) => [key, (options as any)[key]]),
            ),
          });
        if (options?.signal?.aborted) throw new Error("Model request aborted");
        let first = true;
        const stream = await Promise.race([
          Promise.resolve(
            source(
              model,
              {
                ...projected,
                messages: providerHistory(projected.messages, model) as typeof context.messages,
              },
              {
                ...options,
                onPayload: async (payload, requestModel) => {
                  const effective = (await options?.onPayload?.(payload, requestModel)) ?? payload;
                  await diagnostics?.payload(effective);
                  await (options as any)?.intricaBeforeDispatch?.();
                  return effective;
                },
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
                  await options?.onResponse?.(response, responseModel);
                },
              },
            ),
          ),
          cancelled,
        ]);
        const iterator = stream[Symbol.asyncIterator]();
        for (;;) {
          const event = await Promise.race([iterator.next(), cancelled]);
          if (event.done) throw new Error("Model stream ended without result");
          const value = event.value;
          await diagnostics?.observations.observe(value);
          if (first) {
            first = false;
            if (call)
              await call.db.pool.query(
                "update model_calls set first_response_at=coalesce(first_response_at,now()) where id=$1",
                [call.callId],
              );
          }
          if (value.type === "done" || value.type === "error") {
            partial = value.type === "done" ? value.message : value.error;
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
        await diagnostics?.observations.interrupted().catch(() => {});
        const reason = options?.signal?.aborted ? "aborted" : "error";
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
