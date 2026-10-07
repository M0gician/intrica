import { performance } from "node:perf_hooks";
import { DomainError, id } from "../../adapters/postgres/database.js";
import type { Lease, RunStore } from "./store.js";

export type ExecutionContext = {
  run: Lease;
  signal: AbortSignal;
  store: RunStore;
  progress: () => void;
};
export type RunHandler = (context: ExecutionContext) => Promise<void>;
export class Worker {
  readonly ownerId = id("worker");
  private active = new Map<
    string,
    {
      run: Lease;
      abort: AbortController;
      promise: Promise<void>;
      renewedAt: number;
      progressAt: number;
    }
  >();
  private stopping = false;
  private tickTimer: ReturnType<typeof setTimeout> | undefined;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private polling: Promise<void> | undefined;
  constructor(
    readonly store: RunStore,
    readonly handlers: Record<Lease["kind"], RunHandler>,
    readonly schedule: () => Promise<void>,
  ) {}
  start() {
    this.poll();
    void this.watch();
  }
  private poll() {
    this.polling = this.tick();
  }
  private async tick() {
    if (this.stopping) return;
    try {
      await this.store.recover();
      await this.schedule();
      const limits = await this.store.settings.limits();
      while (!this.stopping && this.active.size < limits.agents + limits.generations) {
        const run = await this.store.claim(this.ownerId);
        if (!run) break;
        if (this.stopping) {
          await this.store.fail(run, new Error("shutdown"), true);
          break;
        }
        const abort = new AbortController();
        const entry = {
          run,
          abort,
          renewedAt: performance.now(),
          progressAt: performance.now(),
          promise: Promise.resolve(),
        };
        this.active.set(run.id, entry);
        entry.promise = this.handlers[run.kind]({
          run,
          signal: abort.signal,
          store: this.store,
          progress: () => {
            entry.progressAt = performance.now();
          },
        })
          .catch(async (error) => {
            abort.abort(error);
            console.error("[run]", run.id, error instanceof Error ? error.message : "failed");
            await this.store.fail(run, error, this.stopping);
          })
          .catch((error) => console.error("[run:finish]", run.id, error.message))
          .finally(() => this.active.delete(run.id));
      }
    } catch (error) {
      console.error(
        "[worker:poll]",
        error instanceof Error ? error.message : "database unavailable",
      );
    }
    if (!this.stopping) this.tickTimer = setTimeout(() => this.poll(), 500);
  }
  private async watch() {
    try {
      const entries = [...this.active.values()];
      const ids = entries.map((entry) => entry.run.id);
      if (ids.length) {
        const current = (
          await this.store.db.pool.query(
            "select r.id,r.epoch,r.state,r.cancel_requested_at,r.lease_until>clock_timestamp() as valid from runs r where r.id=any($1::text[])",
            [ids],
          )
        ).rows;
        const byId = new Map(current.map((r) => [r.id, r]));
        for (const entry of entries) {
          const row = byId.get(entry.run.id);
          if (
            !row ||
            row.epoch !== entry.run.epoch ||
            row.state !== "running" ||
            row.cancel_requested_at ||
            !row.valid ||
            performance.now() - entry.progressAt > 300000
          ) {
            entry.abort.abort(new DomainError("CANCELLED", "运行已停止"));
          }
        }
        const due = [...this.active.values()].filter(
          (e) => !e.abort.signal.aborted && performance.now() - e.renewedAt >= 5000,
        );
        if (due.length) {
          const renewed = await this.store.db.pool.query(
            "update runs set lease_until=clock_timestamp()+interval '30 seconds' where id=any($1::text[]) and owner_id=$2 and state='running' and lease_until>clock_timestamp() and cancel_requested_at is null returning id",
            [due.map((e) => e.run.id), this.ownerId],
          );
          const valid = new Set(renewed.rows.map((r) => r.id));
          for (const entry of due) {
            if (valid.has(entry.run.id)) entry.renewedAt = performance.now();
            else entry.abort.abort();
          }
        }
      }
    } catch {
      for (const entry of this.active.values())
        if (performance.now() - entry.renewedAt > 20000)
          entry.abort.abort(new Error("执行租约无法续期"));
    }
    if (!this.stopping || this.active.size)
      this.watchTimer = setTimeout(() => void this.watch(), 250);
  }
  async close() {
    this.stopping = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    for (const entry of this.active.values()) entry.abort.abort();
    await this.polling;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.active.values()].map((e) => e.promise)),
        new Promise((r) => {
          timeout = setTimeout(r, 10000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (this.watchTimer) clearTimeout(this.watchTimer);
  }
}
