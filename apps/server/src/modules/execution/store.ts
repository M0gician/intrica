import {
  assertFence,
  canvasEvent,
  type Database,
  DomainError,
  id,
  lockCanvas,
  type Tx,
} from "../../adapters/postgres/database.js";
import { cancelApprovals, cancellationReason } from "./cancellation.js";
import { DEFAULT_LIMITS, type ExecutionLimits } from "./limits.js";
import { pendingInboxMessage } from "./messages.js";
import { failureReason, publishRunNotice } from "./run-notices.js";
import { ExecutionSettingsStore } from "./settings.js";

export type RunState = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export type Run = {
  id: string;
  canvas_id: string;
  subject_id: string;
  kind: "generation" | "conversation";
  state: RunState;
  epoch: number;
  frozen_input: any;
  reason: string | null;
  created_at: Date;
  owner_id: string | null;
  lease_until: Date | null;
  cancel_requested_at: Date | null;
  cause_id: string;
  last_event_seq: string;
  superseded_by_run_id: string | null;
};
export type Lease = Run & { attemptId: string };
export class RunStore {
  readonly settings: ExecutionSettingsStore;
  constructor(
    readonly db: Database,
    readonly limits: ExecutionLimits = DEFAULT_LIMITS,
  ) {
    this.settings = new ExecutionSettingsStore(db, limits);
  }
  async get(runId: string, tx: Pick<Tx, "query"> = this.db.pool): Promise<Run> {
    const row = (await tx.query("select * from runs where id=$1", [runId])).rows[0];
    if (!row) throw new DomainError("NOT_FOUND", "任务不存在");
    return row;
  }
  async chargeActivation(tx: Tx, causeId: string) {
    return Boolean(
      (
        await tx.query(
          "update runs set activation_count=activation_count+1 where id=$1 and activation_count<$2 returning id",
          [causeId, this.limits.collaborationActivations],
        )
      ).rowCount,
    );
  }
  async conversationBarrier(conversationId: string, tx: Pick<Tx, "query"> = this.db.pool) {
    const paused = (
      await tx.query(
        "select * from runs where subject_id=$1 and reason='tool_contract_upgrade' order by created_at desc,id desc limit 1",
        [conversationId],
      )
    ).rows[0] as Run | undefined;
    const unknown = Boolean(
      (
        await tx.query(
          "select 1 from tool_calls t join runs r on r.id=t.run_id where r.subject_id=$1 and t.state='unknown' limit 1",
          [conversationId],
        )
      ).rowCount,
    );
    return { paused, unknown };
  }
  private async attachInbox(tx: Tx, run: Run, chargedCause?: string) {
    const groups = (
      await tx.query(
        `select m.content->>'causeId' as cause_id,array_agg(m.seq) as seqs
       from messages m join conversations c on c.id=m.conversation_id
       where c.id=$1 and m.seq>c.consumed_message_seq and m.run_id is null and ${pendingInboxMessage}
       group by m.content->>'causeId' order by min(m.seq)`,
        [run.subject_id],
      )
    ).rows;
    for (const group of groups) {
      const admitted =
        !group.cause_id ||
        group.cause_id === chargedCause ||
        (await this.chargeActivation(tx, group.cause_id));
      await tx.query(
        `update messages set run_id=case when $3 then $4 else null end,
         content=case when $3 then content else content||'{"activationBlocked":true}'::jsonb end
         where conversation_id=$1 and seq=any($2::bigint[])`,
        [run.subject_id, group.seqs, admitted, run.id],
      );
    }
  }
  async enqueue(
    tx: Tx,
    input: {
      id?: string;
      canvasId: string;
      subjectId: string;
      kind: Run["kind"];
      frozen: any;
      causeId?: string;
      userInitiated?: boolean;
      resumeRunId?: string;
      delayMs?: number;
    },
  ): Promise<Run> {
    let blocked = false;
    if (input.kind === "conversation") {
      const barrier = await this.conversationBarrier(input.subjectId, tx);
      blocked = barrier.unknown;
      if (barrier.paused) {
        if (!input.userInitiated || input.resumeRunId !== barrier.paused.id) return barrier.paused;
        if (barrier.unknown)
          throw new DomainError("INVALID_STATE", "请先核实此会话中结果未知的工具");
        await tx.query(
          "update runs set state='cancelled',reason=null,cancel_requested_at=null,owner_id=null,lease_until=null,updated_at=now() where subject_id=$1 and reason='tool_contract_upgrade'",
          [input.subjectId],
        );
        await this.eventTx(tx, barrier.paused.id, null, "run.finished", {
          state: "cancelled",
          reason: "tool_contract_upgrade",
          continued: true,
        });
      }
      const prior = (
        await tx.query(
          "select * from runs where kind='conversation' and subject_id=$1 and state in ('queued','running','waiting') for update",
          [input.subjectId],
        )
      ).rows[0];
      if (prior) {
        if (prior.cancel_requested_at)
          throw new DomainError("INVALID_STATE", "运行正在停止，请在停止后重试");
        if (blocked) return prior;
        if (input.userInitiated)
          await tx.query("update runs set activation_count=0 where id=$1", [prior.cause_id]);
        if (
          prior.state === "waiting" &&
          (prior.reason === "message" ||
            prior.reason === "approval" ||
            (["turn_limit", "unknown"].includes(prior.reason) && input.userInitiated))
        ) {
          if (input.causeId && !(await this.chargeActivation(tx, input.causeId)))
            throw new DomainError("LIMIT_REACHED", "本次自动协作已达到传播上限");
          await tx.query(
            "update runs set state='queued',reason=null,cause_id=coalesce($2,cause_id),available_at=now(),updated_at=now() where id=$1",
            [prior.id, input.causeId ?? null],
          );
          await canvasEvent(tx, input.canvasId, "run.changed", {
            id: prior.id,
            state: "queued",
            subjectId: prior.subject_id,
            kind: prior.kind,
          });
        }
        const current = await this.get(prior.id, tx);
        await this.attachInbox(tx, current, input.causeId);
        return current;
      }
    }
    const count = (
      await tx.query(
        "select count(*)::int as count from runs where canvas_id=$1 and state in ('queued','running','waiting')",
        [input.canvasId],
      )
    ).rows[0].count;
    if (count >= (await this.settings.limits(tx, true)).pendingPerCanvas)
      throw new DomainError("QUEUE_FULL", "此画布待处理任务过多，请先处理已有任务");
    if (input.causeId && !(await this.chargeActivation(tx, input.causeId)))
      throw new DomainError("LIMIT_REACHED", "本次自动协作已达到传播上限");
    const runId = input.id ?? id("run");
    const causeId = input.causeId ?? runId;
    await tx.query(
      "insert into runs(id,canvas_id,subject_id,kind,state,frozen_input,cause_id,available_at,reason) values($1,$2,$3,$4,$8,$5,$6,now()+$7*interval '1 millisecond',$9)",
      [
        runId,
        input.canvasId,
        input.subjectId,
        input.kind,
        JSON.stringify(input.frozen),
        causeId,
        input.delayMs ?? 0,
        blocked ? "waiting" : "queued",
        blocked ? "unknown" : null,
      ],
    );
    await canvasEvent(tx, input.canvasId, "run.changed", {
      id: runId,
      state: blocked ? "waiting" : "queued",
      subjectId: input.subjectId,
      kind: input.kind,
    });
    const current = await this.get(runId, tx);
    if (input.kind === "conversation" && !blocked)
      await this.attachInbox(tx, current, input.causeId);
    return current;
  }
  async claim(ownerId: string, capacity?: number): Promise<Lease | null> {
    const limits = await this.settings.limits();
    const candidates = (
      await this.db.pool.query(
        `with active as (
          select canvas_id,kind,count(*)::int as n from runs where state='running' and lease_until>clock_timestamp() group by canvas_id,kind
        ) select id,canvas_id from runs r where state='queued' and available_at<=clock_timestamp() and cancel_requested_at is null
          and ((kind='conversation' and (select coalesce(sum(n),0) from active where kind='conversation')<$1)
            or (kind='generation' and (select coalesce(sum(n),0) from active where kind='generation')<$2
              and (select coalesce(sum(n),0) from active where kind='generation' and canvas_id=r.canvas_id)<$3))
          order by (select coalesce(sum(n),0) from active where canvas_id=r.canvas_id),available_at,created_at,id limit 32`,
        [limits.agents, limits.generations, limits.generationsPerCanvas],
      )
    ).rows;
    for (const candidate of candidates) {
      const lease = await this.db.transaction(async (tx) => {
        await tx.query(
          "select pg_advisory_xact_lock(hashtextextended('intrica-host-admission',0))",
        );
        await lockCanvas(tx, candidate.canvas_id);
        const current = (
          await tx.query(
            "select * from runs where id=$1 and state='queued' and available_at<=clock_timestamp() and cancel_requested_at is null for update skip locked",
            [candidate.id],
          )
        ).rows[0] as Run | undefined;
        if (!current) return null;
        if (current.kind === "conversation") {
          const barrier = await this.conversationBarrier(current.subject_id, tx);
          if (barrier.paused || barrier.unknown) {
            const reason = barrier.paused ? "tool_contract_upgrade" : "unknown";
            await tx.query(
              "update runs set state='waiting',reason=$2,owner_id=null,lease_until=null,updated_at=now() where id=$1",
              [current.id, reason],
            );
            await canvasEvent(tx, current.canvas_id, "run.changed", {
              id: current.id,
              state: "waiting",
              reason,
              subjectId: current.subject_id,
              kind: current.kind,
            });
            return null;
          }
        }
        const limits = await this.settings.limits(tx, true);
        const counts = (
          await tx.query(
            "select count(*)::int as total,count(*) filter(where kind='conversation')::int as agents,count(*) filter(where kind='generation')::int as generations,count(*) filter(where canvas_id=$1 and kind='generation')::int as generation from runs where state='running' and lease_until>clock_timestamp()",
            [current.canvas_id],
          )
        ).rows[0];
        if (
          counts.total >= (capacity ?? limits.agents + limits.generations) ||
          (current.kind === "conversation" && counts.agents >= limits.agents) ||
          (current.kind === "generation" &&
            (counts.generations >= limits.generations ||
              counts.generation >= limits.generationsPerCanvas))
        )
          return null;
        const run = (
          await tx.query(
            "update runs set state='running',owner_id=$2,epoch=epoch+1,lease_until=clock_timestamp()+interval '30 seconds',reason=null,updated_at=now() where id=$1 returning *",
            [current.id, ownerId],
          )
        ).rows[0] as Run;
        const attemptId = id("attempt");
        await tx.query("insert into attempts(id,run_id,epoch,state) values($1,$2,$3,'running')", [
          attemptId,
          run.id,
          run.epoch,
        ]);
        await this.eventTx(tx, run.id, attemptId, "attempt.started", { epoch: run.epoch });
        await canvasEvent(tx, run.canvas_id, "run.changed", {
          id: run.id,
          state: "running",
          subjectId: run.subject_id,
          kind: run.kind,
          epoch: run.epoch,
        });
        return { ...run, attemptId };
      });
      if (lease) return lease;
    }
    return null;
  }
  async eventTx(tx: Tx, runId: string, attemptId: string | null, type: string, payload: unknown) {
    const seq = String(
      (
        await tx.query(
          "update runs set last_event_seq=last_event_seq+1 where id=$1 returning last_event_seq",
          [runId],
        )
      ).rows[0].last_event_seq,
    );
    await tx.query(
      "insert into run_events(run_id,seq,attempt_id,type,payload) values($1,$2,$3,$4,$5)",
      [runId, seq, attemptId, type, JSON.stringify(payload)],
    );
    await tx.query("select pg_notify('intrica_changes',$1)", [runId]);
    return seq;
  }
  async event(lease: Lease, type: string, payload: unknown) {
    return this.db.transaction(async (tx) => {
      await assertFence(tx, lease.id, lease.epoch);
      return this.eventTx(tx, lease.id, lease.attemptId, type, payload);
    });
  }
  async finish(
    lease: Lease,
    state: "succeeded" | "waiting",
    write?: (tx: Tx) => Promise<unknown>,
    reason: string | null = null,
  ) {
    return this.db.canvas(lease.canvas_id, async (tx) => {
      await assertFence(tx, lease.id, lease.epoch);
      if ((await write?.(tx)) === false) return false;
      await tx.query(
        "update runs set state=$2,reason=$3,owner_id=null,lease_until=null,updated_at=now() where id=$1",
        [lease.id, state, reason],
      );
      await tx.query("update attempts set state=$2,ended_at=now() where id=$1", [
        lease.attemptId,
        state,
      ]);
      await this.eventTx(tx, lease.id, lease.attemptId, "run.finished", { state, reason });
      await publishRunNotice(tx, this, lease, state, reason);
      await canvasEvent(tx, lease.canvas_id, "run.changed", {
        id: lease.id,
        state,
        reason,
        subjectId: lease.subject_id,
        kind: lease.kind,
      });
      return true;
    });
  }
  async cancel(runId: string) {
    const run = await this.get(runId);
    return this.db.canvas(
      run.canvas_id,
      async (tx) => {
        const current = await this.get(runId, tx);
        if (!["queued", "running", "waiting"].includes(current.state)) return current;
        await tx.query(
          `update runs set cancel_requested_at=now(),state=case when state='running' then state else 'cancelled' end,reason=${cancellationReason},updated_at=now() where id=$1`,
          [runId],
        );
        await cancelApprovals(tx, [runId]);
        await canvasEvent(tx, run.canvas_id, "run.changed", {
          id: runId,
          state: current.state === "running" ? "running" : "cancelled",
          cancelRequested: true,
          subjectId: run.subject_id,
          kind: run.kind,
        });
        return this.get(runId, tx);
      },
      true,
    );
  }
  async fail(lease: Lease, error: unknown, requeue = false) {
    await this.db.canvas(
      lease.canvas_id,
      async (tx) => {
        const current = (
          await tx.query(
            "select * from runs where id=$1 and epoch=$2 and state='running' and lease_until>clock_timestamp() for update",
            [lease.id, lease.epoch],
          )
        ).rows[0];
        if (!current) return;
        const ambiguous = (
          await tx.query(
            "update tool_calls set state='unknown',updated_at=now() where run_id=$1 and state='dispatching' and effect_class='external' returning id",
            [lease.id],
          )
        ).rowCount;
        const state = ambiguous
          ? "waiting"
          : current.cancel_requested_at
            ? "cancelled"
            : requeue
              ? "queued"
              : "failed";
        const reason = ambiguous
          ? "unknown"
          : requeue
            ? "shutdown"
            : current.cancel_requested_at
              ? "已停止"
              : failureReason(error);
        await tx.query(
          "update runs set state=$2,reason=$3,owner_id=null,lease_until=null,updated_at=now() where id=$1",
          [lease.id, state, reason],
        );
        await tx.query("update attempts set state=$2,failure=$3,ended_at=now() where id=$1", [
          lease.attemptId,
          state === "waiting" ? "failed" : state === "queued" ? "expired" : state,
          reason,
        ]);
        await this.eventTx(tx, lease.id, lease.attemptId, "run.finished", { state, reason });
        await publishRunNotice(tx, this, lease, state, reason);
        await canvasEvent(tx, lease.canvas_id, "run.changed", {
          id: lease.id,
          state,
          reason,
          subjectId: lease.subject_id,
          kind: lease.kind,
        });
      },
      true,
    );
  }
  async recover() {
    const expired = (
      await this.db.pool.query(
        "select id,canvas_id from runs where (state='running' and lease_until<=clock_timestamp()) or (state in ('queued','waiting') and cancel_requested_at is not null) limit 32",
      )
    ).rows;
    for (const row of expired)
      await this.db.canvas(
        row.canvas_id,
        async (tx) => {
          const run = (
            await tx.query(
              "select * from runs where id=$1 and ((state='running' and lease_until<=clock_timestamp()) or (state in ('queued','waiting') and cancel_requested_at is not null)) for update",
              [row.id],
            )
          ).rows[0];
          if (!run) return;
          const unknown = (
            await tx.query(
              "update tool_calls set state='unknown',updated_at=now() where run_id=$1 and state='dispatching' and effect_class='external' returning id",
              [row.id],
            )
          ).rowCount;
          const failures = (
            await tx.query(
              "select count(*)::int as count from attempts where run_id=$1 and state='expired' and failure='lease_expired' and epoch>coalesce((select max(epoch) from attempts where run_id=$1 and (state in('waiting','succeeded') or failure='shutdown')),0)",
              [run.id],
            )
          ).rows[0].count;
          const state = unknown
            ? "waiting"
            : run.cancel_requested_at
              ? "cancelled"
              : failures >= 2
                ? "failed"
                : "queued";
          const reason = unknown ? "unknown" : state === "failed" ? "重启恢复次数已达到上限" : null;
          await tx.query(
            "update attempts set state='expired',failure='lease_expired',ended_at=now() where run_id=$1 and state='running'",
            [row.id],
          );
          await tx.query(
            "update runs set state=$2,reason=$3,owner_id=null,lease_until=null,available_at=now(),updated_at=now() where id=$1",
            [row.id, state, reason],
          );
          await canvasEvent(tx, row.canvas_id, "run.changed", {
            id: row.id,
            state,
            reason,
            kind: run.kind,
            subjectId: run.subject_id,
          });
          await publishRunNotice(tx, this, run, state, reason);
        },
        true,
      );
  }
}
