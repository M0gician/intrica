import { ProcessOutcomeError } from "../../adapters/host/process-outcome.js";
import { assertFence, DomainError, digest, type Tx } from "../../adapters/postgres/database.js";
import { promptText } from "../../prompt-language.js";
import {
  invocationStage,
  recordInvocation,
  rejectInput,
  type ToolObservation,
} from "./tool-ledger.js";
import { backgroundResult, result, type ToolResult } from "./tool-results.js";
import { toolInputError } from "./tool-validation.js";
import type { ExecutionContext } from "./worker.js";

export type { StoredToolCall, ToolResult } from "./tool-results.js";
export { backgroundResult, result, storedToolResult } from "./tool-results.js";

// Version 2 removes caller-provided names from hire_agent.
export const TOOL_SCHEMA_VERSION = 2;

export type ExecutionTool = {
  name: string;
  /** Discovery only; handlers still enforce identity and current permissions. */
  modelVisible?: boolean;
  /** A narrowed discovery schema; durable recovery retains the original execution schema. */
  modelParameters?: any;
  label: string;
  description: string;
  parameters: any;
  effect: "read" | "graph" | "external";
  /** Opt in only for independent reads; permission/message/control tools remain sequential. */
  parallel?: boolean;
  normalize?: (args: any) => Promise<any>;
  /** Adapt only persisted calls from an earlier schema; their input hash stays unchanged. */
  restore?: (args: any) => any;
  prepare?: (
    tx: Tx,
    callId: string,
    logicalId: string,
    args: any,
  ) => Promise<ToolResult | undefined>;
  execute: (logicalId: string, args: any, signal: AbortSignal) => Promise<ToolResult>;
};

export type ToolExecution = {
  result: ToolResult;
  waiting?: "approval" | "message" | "unknown" | "tool_input";
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

export async function invokeTool(
  ctx: ExecutionContext,
  tool: ExecutionTool | string,
  logicalId: string,
  args: unknown,
  onChange?: (tx: Tx, event: Record<string, unknown>) => Promise<void>,
  background?: {
    afterMs: number;
    detach: (callId: string, completion: Promise<ToolExecution>) => void;
  },
  inputVersion = TOOL_SCHEMA_VERSION,
  observation?: ToolObservation,
): Promise<ToolExecution> {
  const name = typeof tool === "string" ? tool : tool.name;
  const definition = typeof tool === "string" ? undefined : tool;
  const store = ctx.store;
  const hash = digest(args ?? null);
  let callId = "";
  let executionArgs: any = args;
  const emit = async (tx: Tx, event: Record<string, unknown>) => {
    await store.eventTx(tx, ctx.run.id, ctx.run.attemptId, "tool", event);
    await onChange?.(tx, event);
  };
  const prior = await store.db.canvas(ctx.run.canvas_id, async (tx) => {
    await assertFence(tx, ctx.run.id, ctx.run.epoch);
    const row = (
      await tx.query("select * from tool_calls where run_id=$1 and logical_call_id=$2 for update", [
        ctx.run.id,
        logicalId,
      ])
    ).rows[0];
    if (row) {
      if (row.args_hash !== hash || row.name !== name)
        throw new DomainError("IDEMPOTENCY_CONFLICT", "恢复的工具参数不一致");
      callId = row.id;
      if (["succeeded", "failed", "unknown", "waiting"].includes(row.state)) return row;
      // Safe reads may have lost their result when the worker exited. Re-run their
      // preflight with the same frozen input and receipt before dispatching again.
      if (row.state === "dispatching" && row.effect_class !== "external")
        await tx.query("update tool_calls set state='prepared' where id=$1", [row.id]);
    }
    if (!row)
      callId = await recordInvocation(tx, ctx, {
        name,
        logicalId,
        args,
        hash,
        schemaVersion: inputVersion,
        definition,
        observation,
      });
    const restoring = Boolean(row) || inputVersion < TOOL_SCHEMA_VERSION;
    const validationArgs = restoring && definition?.restore ? definition.restore(args) : args;
    const parameters =
      definition?.parameters.type === "object"
        ? {
            ...definition.parameters,
            additionalProperties: definition.parameters.additionalProperties ?? false,
          }
        : definition?.parameters;
    const inputError = toolInputError(name, parameters, validationArgs, observation?.parseError);
    if (inputError) {
      const output = await rejectInput(tx, ctx, callId, inputError);
      await emit(tx, {
        id: logicalId,
        callId,
        name,
        args,
        status: "error",
        result: output,
        phase: inputError.phase,
        executed: false,
      });
      return { state: "failed", result: output };
    }
    const barrier = await store.conversationBarrier(ctx.run.subject_id, tx);
    if (barrier.paused || barrier.unknown) {
      const output = {
        ...result({
          error: "EXECUTION_BLOCKED",
          executed: false,
          reason: barrier.unknown ? "unknown_outcome" : "paused",
        }),
        isError: true,
      };
      await tx.query(
        "update tool_calls set state='failed',result=$2,completed_at=now() where id=$1",
        [callId, JSON.stringify(output)],
      );
      await invocationStage(tx, callId, "authorization", false, "EXECUTION_BLOCKED");
      await emit(tx, {
        id: logicalId,
        callId,
        name,
        args,
        status: "error",
        result: output,
        phase: "authorization",
        executed: false,
      });
      return { state: "unknown", result: output };
    }
    const checked = definition!;
    let phase = "validation";
    await tx.query("savepoint tool_preflight");
    try {
      const expedited = (
        await tx.query(
          "select 1 from messages m join conversations c on c.id=m.conversation_id where m.conversation_id=$1 and (m.seq>c.consumed_message_seq or m.content->>'workItemId' is not null) and m.content->>'closed' is distinct from 'true' and m.expedite_run_id=$2 and m.consumed_run_id is null limit 1",
          [ctx.run.subject_id, ctx.run.id],
        )
      ).rowCount;
      const generation = row?.generation ?? ctx.run.frozen_input.generation;
      const currentGeneration = (
        await tx.query("select generation from conversations where id=$1", [ctx.run.subject_id])
      ).rows[0]?.generation;
      const stale = generation != null && Number(generation) !== Number(currentGeneration);
      if (expedited || stale) {
        if (row?.is_async && !stale) return { state: "prepared", result: null };
        const output = {
          ...result({
            executed: false,
            reason: "expedited_input",
            nextAction: "Read the new input before choosing the next operation.",
          }),
          isError: true,
        };
        await tx.query(
          "update tool_calls set state='failed',result=$2,updated_at=now() where id=$1",
          [callId, JSON.stringify(output)],
        );
        await emit(tx, { id: logicalId, callId, name, args, status: "error", result: output });
        return { state: "failed", result: output };
      }
      executionArgs =
        row?.execution_input ??
        (checked.normalize ? await checked.normalize(validationArgs) : validationArgs);
      if (restoring && checked.restore) executionArgs = checked.restore(executionArgs);
      await tx.query("update tool_calls set execution_input=$2 where id=$1", [
        callId,
        JSON.stringify(executionArgs),
      ]);
      phase = "authorization";
      const output = await checked.prepare?.(tx, callId, logicalId, executionArgs);
      if (output) {
        const state =
          output.control?.waiting === "approval"
            ? "waiting"
            : output.isError
              ? "failed"
              : "succeeded";
        await tx.query(
          "update tool_calls set state=$2,result=$3,approval_id=coalesce($4,approval_id),completed_at=case when $2 in('succeeded','failed') then now() else completed_at end,updated_at=now() where id=$1",
          [callId, state, JSON.stringify(output), output.control?.approvalId ?? null],
        );
        await invocationStage(
          tx,
          callId,
          state === "succeeded" ? "complete" : phase,
          state === "succeeded",
        );
        await emit(tx, {
          id: logicalId,
          callId,
          name,
          args,
          status: state === "waiting" ? "waiting" : state === "failed" ? "error" : "complete",
          result: output,
        });
        return { state, result: output };
      }
    } catch (error) {
      await tx.query("rollback to savepoint tool_preflight");
      const output = {
        ...result(
          error instanceof DomainError && error.code === "REQUEST_CLOSED"
            ? { error: error.code, message: error.message, existingReply: error.details }
            : {
                error: error instanceof DomainError ? error.code : "TOOL_PREPARATION_FAILED",
                message:
                  error instanceof DomainError
                    ? error.message
                    : "Tool preparation failed before execution.",
                phase,
                executed: false,
              },
        ),
        isError: true,
      };
      const retryable = !(error instanceof DomainError);
      await tx.query("update tool_calls set state=$3,result=$2 where id=$1", [
        callId,
        JSON.stringify(output),
        retryable ? "prepared" : "failed",
      ]);
      await invocationStage(
        tx,
        callId,
        phase,
        false,
        error instanceof DomainError ? error.code : "TOOL_PREPARATION_FAILED",
      );
      await emit(tx, {
        id: logicalId,
        callId,
        name,
        args,
        status: "error",
        result: output,
      });
      return { state: retryable ? "retryable" : "failed", result: output, cause: error };
    }
    await tx.query("select pg_advisory_xact_lock(hashtextextended('intrica-tool-admission',0))");
    const limits = await store.settings.limits(tx, true);
    const counts = (
      await tx.query(
        "select count(*)::int as total,count(*) filter(where t.run_id=$1)::int as own from tool_calls t join runs r on r.id=t.run_id where t.id<>$2 and t.state='dispatching' and r.state='running' and r.lease_until>clock_timestamp()",
        [ctx.run.id, callId],
      )
    ).rows[0];
    if (
      name !== "get_tool_result" &&
      (counts.total >= limits.tools || counts.own >= limits.toolsPerAgent)
    ) {
      if (row?.is_async && row.state === "prepared")
        return { state: "prepared", result: null, id: callId };
      const busy = {
        ...result(
          promptText(
            ctx.run.frozen_input.language,
            "The tool concurrency limit has been reached. Wait for background calls to finish; do not retry in a loop.",
            "并发工具已达到上限。等待后台调用完成后再继续，不要立即循环重试。",
          ),
        ),
        isError: true,
      };
      await tx.query("update tool_calls set state='failed',result=$2 where id=$1", [
        callId,
        JSON.stringify(busy),
      ]);
      await emit(tx, {
        id: logicalId,
        callId,
        name,
        args,
        status: "error",
        result: busy,
      });
      return { state: "failed", result: busy };
    }
    await tx.query(
      "update tool_calls set state='dispatching',attempt_id=$2,dispatched_at=now(),updated_at=now() where id=$1",
      [callId, ctx.run.attemptId],
    );
    await invocationStage(tx, callId, "execution", true);
    await emit(tx, { id: logicalId, callId, name, status: "running", args });
    return null;
  });
  if (prior?.state === "retryable" && "cause" in prior) throw prior.cause;
  if (prior?.state === "prepared") return backgroundResult(callId, ctx.run.frozen_input.language);
  if (prior?.state === "unknown")
    return {
      result: prior.result ?? {
        ...result(
          promptText(
            ctx.run.frozen_input.language,
            "The previous outcome is unknown and requires user verification.",
            "上次操作的结果尚未确认，需要用户核实",
          ),
        ),
        isError: true,
      },
      waiting: "unknown",
    };
  if (prior)
    return {
      result: {
        ...prior.result,
        isError: prior.state === "failed" || Boolean(prior.result?.isError),
      },
      ...(prior.state === "waiting" ? { waiting: "approval" as const } : {}),
      ...(prior.result?.control?.waiting === "tool_input"
        ? { waiting: "tool_input" as const }
        : {}),
      ...(prior.state === "succeeded" && prior.result?.control?.waiting === "message"
        ? { waiting: "message" as const }
        : {}),
    };
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
  const completed = await Promise.race([
    completion,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), background.afterMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
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
