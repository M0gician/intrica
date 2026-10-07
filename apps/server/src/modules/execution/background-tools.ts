import { assertFence, type Tx } from "../../adapters/postgres/database.js";
import { promptText } from "../../prompt-language.js";
import {
  backgroundResult,
  type ExecutionTool,
  invokeTool,
  storedToolResult,
} from "./tool-calls.js";
import type { ExecutionContext } from "./worker.js";

export type ToolNotice = {
  text: string;
  callId: string;
  status: string;
  progress: boolean;
  elapsedSeconds: number;
  reviewRequired: boolean;
};

/** Promises retain live calls; tool_calls and conversation messages retain durable outcomes. */
export class BackgroundTools {
  private pending = new Map<string, { callId: string; completion: Promise<void> }>();
  private failure: unknown;
  private abort = new AbortController();
  private changed = false;
  private wake: (() => void) | undefined;
  constructor(
    readonly ctx: ExecutionContext,
    readonly tools: ExecutionTool[],
    readonly log: (tx: Tx, event: Record<string, unknown>) => Promise<void>,
    readonly notify: (tx: Tx, key: string, content: ToolNotice) => Promise<unknown>,
  ) {
    this.ctx = { ...ctx, signal: AbortSignal.any([ctx.signal, this.abort.signal]) };
  }
  invoke(
    tool: ExecutionTool | string,
    logicalId: string,
    args: unknown,
    resumed = false,
  ): ReturnType<typeof invokeTool> {
    const active = this.pending.get(logicalId);
    if (active)
      return Promise.resolve(backgroundResult(active.callId, this.ctx.run.frozen_input.language));
    return invokeTool(
      this.ctx,
      tool,
      logicalId,
      args,
      async (tx, event) => {
        await this.log(tx, event);
        if (!["complete", "error", "unknown", "waiting"].includes(String(event.status))) return;
        const row = (
          await tx.query(
            "select * from tool_calls where id=$1 and run_id=$2 and is_async and delivered_at is null",
            [event.callId, this.ctx.run.id],
          )
        ).rows[0];
        // Publish in the SAME transaction as the outcome, even while inference is in flight.
        if (row && !["prepared", "dispatching"].includes(row.state)) await this.publish(tx, row);
      },
      {
        afterMs: resumed ? 0 : this.ctx.store.limits.toolAsyncAfterMs,
        detach: (callId, completion) => {
          const pending = completion
            .then(
              () => {},
              (error) => {
                this.failure = error;
              },
            )
            .finally(() => {
              this.pending.delete(logicalId);
              this.changed = true;
              this.wake?.();
            });
          this.pending.set(logicalId, { callId, completion: pending });
        },
      },
    );
  }
  async resume(recover = true) {
    const rows = (
      await this.ctx.store.db.pool.query(
        "select * from tool_calls where run_id=$1 and is_async and (state='prepared' or ($2 and state in('dispatching','waiting'))) order by created_at",
        [this.ctx.run.id, recover],
      )
    ).rows;
    for (const row of rows) {
      const tool = this.tools.find((t) => t.name === row.name);
      await this.invoke(tool ?? row.name, row.logical_call_id, row.args, true);
    }
  }
  /** A pending approval suspends one call, not the conversation's inbox. */
  async parkApproval(logicalId: string) {
    await this.ctx.store.db.canvas(this.ctx.run.canvas_id, async (tx) => {
      await assertFence(tx, this.ctx.run.id, this.ctx.run.epoch);
      await tx.query(
        "update tool_calls set is_async=true,delivered_at=case when state='waiting' then now() else null end where run_id=$1 and logical_call_id=$2",
        [this.ctx.run.id, logicalId],
      );
    });
  }
  private async publish(tx: Tx, row: any) {
    const active = ["prepared", "dispatching"].includes(row.state);
    const count = Number(row.notice_count) + 1;
    const elapsedSeconds = Math.max(
      0,
      Math.floor(
        (Date.now() - new Date(active ? row.updated_at : row.created_at).getTime()) / 1000,
      ),
    );
    const key = active
      ? `background-${row.id}-progress-${count}`
      : `background-${row.id}-${row.state}-${row.approval_id ?? "result"}`;
    await this.notify(tx, key, {
      callId: row.id,
      status: row.state,
      progress: active,
      elapsedSeconds,
      reviewRequired: active && count === 1,
      text: active
        ? promptText(
            this.ctx.run.frozen_input.language,
            `Background tool ${row.name} (${row.id}) has been running for ${elapsedSeconds}s; no final result yet. Check whether the command, search scope and duration match the task's expectations. Do not repeat the call or claim success; deliver available findings and identify this unfinished tool.`,
            `后台工具 ${row.name}（${row.id}）已运行 ${elapsedSeconds} 秒，尚无最终结果。请检查命令、搜索范围和耗时是否正确并符合任务预期；不要重复调用或声称成功，先交付已有结论并标明此未完成工具。`,
          )
        : storedToolResult(row, 2000, this.ctx.run.frozen_input.language)
            .content.flatMap((p) => (p.type === "text" ? [p.text] : []))
            .join("\n"),
    });
    await tx.query(
      "update tool_calls set notice_count=$2,delivered_at=case when $3 then null else now() end,next_notice_at=now()+$4*interval '1 millisecond' where id=$1",
      [
        row.id,
        count,
        active,
        this.ctx.store.limits.toolNoticeMs * Math.min(5, 2 ** Math.min(count, 3)),
      ],
    );
  }
  async deliver() {
    if (this.failure) throw this.failure;
    await this.resume(false);
    const { store, run } = this.ctx;
    const rows = (
      await store.db.pool.query(
        "select id,state,next_notice_at from tool_calls where run_id=$1 and is_async and delivered_at is null",
        [run.id],
      )
    ).rows;
    const active = rows.some((r) => ["prepared", "dispatching"].includes(r.state));
    // Waiting without a state change must not take the canvas write lock.
    if (
      !rows.some(
        (r) =>
          !["prepared", "dispatching"].includes(r.state) ||
          (r.next_notice_at && new Date(r.next_notice_at).getTime() <= Date.now()),
      )
    )
      return active;
    return store.db.canvas(run.canvas_id, async (tx) => {
      await assertFence(tx, run.id, run.epoch);
      const due = (
        await tx.query(
          "select * from tool_calls where run_id=$1 and is_async and delivered_at is null and (state not in('prepared','dispatching') or next_notice_at<=clock_timestamp()) order by created_at for update",
          [run.id],
        )
      ).rows;
      for (const row of due) await this.publish(tx, row);
      return this.pendingIn(tx);
    });
  }
  async pendingIn(tx: Pick<Tx, "query">) {
    return Boolean(
      (
        await tx.query(
          "select 1 from tool_calls where run_id=$1 and is_async and (state in('prepared','dispatching') or delivered_at is null) limit 1",
          [this.ctx.run.id],
        )
      ).rowCount,
    );
  }
  async wait() {
    this.ctx.progress();
    this.ctx.signal.throwIfAborted();
    if (this.changed) {
      this.changed = false;
      return;
    }
    // Completion wakes immediately. Polling covers cross-process input and approvals.
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.wake = undefined;
        this.changed = false;
        this.ctx.signal.removeEventListener("abort", finish);
        if (this.ctx.signal.aborted) reject(this.ctx.signal.reason);
        else resolve();
      };
      const timer = setTimeout(finish, 1000);
      this.wake = finish;
      this.ctx.signal.addEventListener("abort", finish, { once: true });
      if (this.ctx.signal.aborted || this.changed) finish();
    });
  }
  async close() {
    this.abort.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.pending.values()].map((entry) => entry.completion)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
