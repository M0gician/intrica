import { ProcessOutcomeError } from "../../adapters/host/process-outcome.js";
import { assertFence, DomainError, type Tx } from "../../adapters/postgres/database.js";
import type { ExecutionTool, ToolExecution } from "./tool-calls.js";
import { invocationStage } from "./tool-ledger.js";
import { backgroundResult, result, type ToolResult } from "./tool-results.js";
import type { ExecutionContext } from "./worker.js";

export type ToolBackground = {
  afterMs: number;
  detach: (callId: string, completion: Promise<ToolExecution>) => void;
  interrupt?: AbortSignal | undefined;
};

async function executeWithDeadline(
  ctx: ExecutionContext,
  tool: ExecutionTool,
  logicalId: string,
  args: unknown,
) {
  const deadline = new AbortController();
  const signal = AbortSignal.any([ctx.signal, deadline.signal]);
  let rejectAbort: (reason: unknown) => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  // Give cooperative process supervisors a bounded interval to return termination evidence.
  const abort = () => {
    abortTimer = setTimeout(() => rejectAbort(signal.reason ?? new Error("工具已停止")), 500);
  };
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => deadline.abort(new Error("工具执行超过总时限")),
    ctx.store.limits.toolTimeoutMs,
  );
  try {
    signal.throwIfAborted();
    return await Promise.race([tool.execute(logicalId, args, signal), interrupted]);
  } finally {
    clearTimeout(timer);
    clearTimeout(abortTimer);
    signal.removeEventListener("abort", abort);
  }
}

/** Completion belongs to the original durable call, including after inference is interrupted. */
export async function completeToolCall(
  ctx: ExecutionContext,
  definition: ExecutionTool,
  logicalId: string,
  executionArgs: unknown,
  callId: string,
  args: unknown,
  emit: (tx: Tx, event: Record<string, unknown>) => Promise<void>,
  background?: ToolBackground,
): Promise<ToolExecution> {
  const store = ctx.store,
    name = definition.name;
  const completion = (async () => {
    let output: ToolResult;
    let failed = false;
    let ambiguous = false;
    try {
      ctx.signal.throwIfAborted();
      output = await executeWithDeadline(ctx, definition!, logicalId, executionArgs);
      if (store.media && ctx.run.kind === "conversation") {
        try {
          output = await store.media.pack(output, ctx.run.subject_id, callId);
        } catch {
          output = {
            ...output,
            content: output.content.map((part) =>
              part.type === "image"
                ? {
                    type: "text",
                    text: "[The tool finished, but its image could not be stored. Do not repeat a completed external operation to recover the image.]",
                  }
                : part,
            ),
            details: { ...output.details, mediaUnavailable: true },
          };
        }
      }
      failed = Boolean(output.isError);
      ctx.progress();
    } catch (error) {
      if (ctx.signal.aborted) {
        if (error instanceof ProcessOutcomeError)
          await store.db.pool.query(
            "update tool_calls t set result=$4 from runs r where t.id=$1 and t.run_id=r.id and r.epoch=$2 and t.attempt_id=$3 and r.state='running' and r.lease_until>clock_timestamp() and t.state='dispatching'",
            [
              callId,
              ctx.run.epoch,
              ctx.run.attemptId,
              JSON.stringify({ ...result(error.outcome), isError: true }),
            ],
          );
        throw error;
      }
      failed = true;
      ambiguous =
        definition!.effect !== "read" &&
        !(error instanceof DomainError) &&
        !(error instanceof ProcessOutcomeError && error.outcome.termination === "start_failed");
      output = {
        ...result(
          error instanceof ProcessOutcomeError
            ? error.outcome
            : error instanceof DomainError
              ? { error: error.code, message: error.message, phase: "execution", executed: true }
              : "工具执行失败或超时；有副作用的操作需要核实结果",
        ),
        isError: true,
      };
    }
    let waiting: ToolExecution["waiting"] = ambiguous ? "unknown" : output.control?.waiting;
    await store.db.canvas(ctx.run.canvas_id, async (tx) => {
      await assertFence(tx, ctx.run.id, ctx.run.epoch);
      const current = (
        await tx.query("select state,result from tool_calls where id=$1 for update", [callId])
      ).rows[0];
      if (current.state !== "dispatching") {
        output = current.result;
        waiting = current.state === "waiting" ? "approval" : undefined;
        return;
      }
      await tx.query(
        "update tool_calls set state=$2,result=$3,completed_at=now(),updated_at=now() where id=$1",
        [
          callId,
          waiting === "unknown"
            ? "unknown"
            : waiting === "approval"
              ? "waiting"
              : failed
                ? "failed"
                : "succeeded",
          JSON.stringify(output),
        ],
      );
      await invocationStage(
        tx,
        callId,
        failed ? "execution" : output.details.mediaUnavailable ? "result" : "complete",
        true,
        ambiguous ? "OUTCOME_UNKNOWN" : failed ? "TOOL_EXECUTION_FAILED" : undefined,
      );
      await emit(tx, {
        id: logicalId,
        callId,
        name,
        args,
        status:
          waiting === "unknown" ? "unknown" : waiting ? "waiting" : failed ? "error" : "complete",
        result: output,
      });
    });
    return { result: output, ...(waiting ? { waiting } : {}) };
  })();
  if (!background) return completion;
  // Keep the same execution and lease: crossing the deadline never restarts a tool.
  void completion.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | undefined;
  const completed = await Promise.race([
    completion,
    new Promise<null>((resolve) => {
      release = () => resolve(null);
      timer = setTimeout(release, background.afterMs);
      background.interrupt?.addEventListener("abort", release, { once: true });
      if (background.interrupt?.aborted) release();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
    if (release) background.interrupt?.removeEventListener("abort", release);
  });
  if (completed) return completed;
  const detached = await store.db.canvas(ctx.run.canvas_id, async (tx) => {
    await assertFence(tx, ctx.run.id, ctx.run.epoch);
    const changed = await tx.query(
      "update tool_calls set is_async=true,next_notice_at=coalesce(next_notice_at,now()+$2*interval '1 millisecond') where id=$1 and state='dispatching' returning id",
      [callId, store.limits.toolNoticeMs],
    );
    if (!changed.rowCount) return false;
    await emit(tx, { id: logicalId, callId, name, args, status: "background" });
    return true;
  });
  if (!detached) return completion;
  background.detach(callId, completion);
  return backgroundResult(callId, ctx.run.frozen_input.language);
}
