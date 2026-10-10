import type { Agent } from "../../adapters/model/agent.js";
import { continuationCapabilities, PiEvents } from "../../adapters/model/pi-events.js";
import { withInferenceAttempt } from "../../adapters/model/usage.js";
import { DomainError, type Tx } from "../../adapters/postgres/database.js";
import type { BackgroundTools } from "../execution/background-tools.js";
import type { ToolExecution } from "../execution/tool-calls.js";
import type { ExecutionContext } from "../execution/worker.js";
import { contextManifest, providerHistory } from "./context-projection.js";
import { ItemStore } from "./item-store.js";
import { beginSettling, claimDispatch, openAttempt, sealRequest } from "./lifecycle.js";
import { backoff, retryDecision } from "./retry-policy.js";
import type { InferenceEvent, InferenceIdentity } from "./types.js";

export type InferenceHooks = {
  persist: (tx: Tx) => Promise<void>;
  checkpoint: () => Promise<void>;
  refresh: () => Promise<void>;
  admitTools: (interrupt: AbortSignal) => Promise<void>;
};

/** Owns one logical inference request, its attempts and the bounded input cutover. */
export async function infer(
  model: Agent,
  ctx: ExecutionContext,
  background: BackgroundTools,
  expedited: () => Promise<boolean>,
  requestId: string,
  workItemId: string | undefined,
  decisionRevision: number,
  hooks: InferenceHooks,
) {
  const cutover = new AbortController();
  const settleMs = Math.max(1, Number(process.env.INTRICA_INFERENCE_SETTLE_MS) || 1000);
  const idleMs = Math.max(1, Number(process.env.INTRICA_INFERENCE_IDLE_MS) || 300_000);
  let active: InferenceIdentity | undefined;
  const stopMonitor = await background.monitorInference(async () => {
    if (!cutover.signal.aborted && (await expedited())) {
      if (active) await beginSettling(ctx, active, settleMs);
      cutover.abort(new DomainError("EXPEDITED", "有加急输入"));
    }
  });
  try {
    for (let attempt = 0; ; attempt++) {
      ctx.signal.throwIfAborted();
      if (cutover.signal.aborted || (await expedited())) return null;
      await hooks.refresh();
      await hooks.checkpoint();
      let identity: InferenceIdentity;
      try {
        identity = await openAttempt(
          ctx,
          {
            conversationId: ctx.run.subject_id,
            workItemId,
            runId: ctx.run.id,
            requestId,
            leaseEpoch: ctx.run.epoch,
            decisionRevision,
          },
          continuationCapabilities(model.state.model.api),
          contextManifest(providerHistory(model.state.messages, model.state.model, true)),
        );
      } catch (error) {
        // Input can win the canvas lock after the initial check and before preparation.
        if (error instanceof DomainError && error.code === "EXPEDITED") return null;
        throw error;
      }
      active = identity;
      const store = new ItemStore(ctx, identity);
      let observed = false;
      const event = async (value: InferenceEvent) => {
        ctx.signal.throwIfAborted();
        ctx.progress();
        if (value.type === "request.started") observed = true;
        if (
          ["item.started", "item.delta", "item.closed"].includes(value.type) &&
          "index" in value
        ) {
          observed = true;
          await store.observe(
            value.index,
            value.block,
            value.type === "item.closed" ? "closed" : "streaming",
          );
        }
        if (value.type === "item.continuation_ready") {
          await store.commit(value, model, hooks.persist);
          await hooks.admitTools(cutover.signal);
        }
      };
      try {
        await claimDispatch(ctx, identity, false);
        const message = await withInferenceAttempt(identity, () =>
          model.turn(ctx.signal, undefined, {
            event,
            beforeStart: () => claimDispatch(ctx, identity, false),
            beforeDispatch: () => claimDispatch(ctx, identity),
            cutover: cutover.signal,
            settleMs,
            idleMs,
          }),
        );
        // A complete-response adapter may provide only a terminal event.
        if (!observed) {
          const position = model.state.messages.indexOf(message);
          if (position >= 0) model.state.messages.splice(position, 1);
          for (const value of new PiEvents(model.state.model).events({
            type: "done",
            reason: message.stopReason as "stop",
            message,
          }))
            await event(value);
        }
        const complete = (await store.states()).every((state) => state === "committed");
        await store.seal(
          cutover.signal.aborted ? "cutover" : complete ? "completed" : "continuation_incomplete",
        );
        if (cutover.signal.aborted || (await expedited())) return null;
        if (!complete)
          throw new DomainError("CONTINUATION_INCOMPLETE", "供应商输出缺少合法续接字段");
        return message;
      } catch (error) {
        if (error instanceof DomainError && error.code === "INFERENCE_TOOL_WAIT") {
          await store.seal("tool_wait");
          return {
            waiting: (error.details as { waiting: NonNullable<ToolExecution["waiting"]> }).waiting,
          };
        }
        const committed = (await store.states()).some((state) => state === "committed");
        const interrupted =
          cutover.signal.aborted ||
          (await expedited()) ||
          (error instanceof DomainError && error.code === "EXPEDITED");
        const decision = retryDecision(
          error,
          attempt,
          committed,
          interrupted || ctx.signal.aborted,
        );
        await store.seal(decision, ["fail", "cutover"].includes(decision)).catch((sealError) => {
          if (!ctx.signal.aborted) throw sealError;
        });
        if (ctx.signal.aborted) throw error;
        if (decision === "cutover") return null;
        if (decision === "fail") throw error;
        if (decision === "continue") {
          // Complete original tool pairs before constructing a continuation payload.
          await hooks.admitTools(cutover.signal);
          model.state.messages.push({
            role: "user",
            content:
              "Server inference notice: The previous request ended before completion. Committed context and real tool receipts are retained. Text drafts remain unpublished. Continue the current task from these records.",
            timestamp: Date.now(),
          });
          await hooks.checkpoint();
        }
        await backoff(1000 * (attempt + 1), AbortSignal.any([ctx.signal, cutover.signal]));
      } finally {
        active = undefined;
      }
    }
  } finally {
    await stopMonitor();
    await sealRequest(ctx, requestId).catch((error) => {
      if (!ctx.signal.aborted) throw error;
    });
  }
}
