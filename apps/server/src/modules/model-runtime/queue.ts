import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Database, DomainError, digest, id } from "../../adapters/postgres/database.js";
import type { ModelFailure } from "./errors.js";
import { recordResponseValidation } from "./queue-validation.js";
import type { ResponseValidation } from "./response-validation.js";

export type RequestIdentity = {
  id: string;
  runId?: string | undefined;
  runEpoch?: number | undefined;
  conversationId: string;
  purpose: string;
  endpointId?: string | undefined;
  endpointKey: string;
  sourceHash: string;
};

export class ModelQueue {
  constructor(
    readonly db: Database,
    readonly request: RequestIdentity,
  ) {}
  validate(owner: string, attempt: number, receipt: ResponseValidation, feedback: string | null) {
    return recordResponseValidation(this.db, this.request, owner, attempt, receipt, feedback);
  }
  async initialize() {
    const r = this.request;
    return this.db.transaction(async (tx) => {
      if (
        r.runEpoch !== undefined &&
        !(
          await tx.query(
            "select id from runs where id=$1 and epoch=$2 and state='running' and lease_until>clock_timestamp() and cancel_requested_at is null",
            [r.runId, r.runEpoch],
          )
        ).rowCount
      )
        throw new DomainError(
          "MODEL_RUN_EXPIRED",
          "Model run is no longer current / 模型运行已失效",
        );
      const endpoint = r.endpointId
        ? (await tx.query("select quota_group_id from model_endpoints where id=$1", [r.endpointId]))
            .rows[0]
        : undefined;
      const groupId =
        endpoint?.quota_group_id ??
        r.endpointId ??
        `endpoint-${digest(r.endpointKey).slice(0, 24)}`;
      await tx.query("insert into model_quota_groups(id) values($1) on conflict do nothing", [
        groupId,
      ]);
      await tx.query(
        `insert into model_requests(id,run_id,conversation_id,purpose,group_id,source_hash)
        values($1,$2,$3,$4,$5,$6) on conflict(id) do nothing`,
        [r.id, r.runId ?? null, r.conversationId, r.purpose, groupId, r.sourceHash],
      );
      if (r.runId)
        await tx.query(
          "update model_requests set state='cancelled',reason='MODEL_SOURCE_REPLACED',owner=null,finished_at=now() where run_id=$1 and purpose=$2 and id<>$3 and state in ('queued','retry_wait','leased','streaming')",
          [r.runId, r.purpose, r.id],
        );
      const stored = (
        await tx.query("select source_hash,group_id from model_requests where id=$1", [r.id])
      ).rows[0];
      if (stored.source_hash !== r.sourceHash)
        throw new DomainError(
          "MODEL_IDENTITY_CONFLICT",
          "Model request source changed / 模型请求来源已变化",
        );
      return stored.group_id as string;
    });
  }
  async admit(groupId: string, retryWindowMs = 600000) {
    return this.db.transaction(async (tx) => {
      if (
        this.request.runEpoch !== undefined &&
        !(
          await tx.query(
            "select id from runs where id=$1 and epoch=$2 and state='running' and lease_until>clock_timestamp() and cancel_requested_at is null",
            [this.request.runId, this.request.runEpoch],
          )
        ).rowCount
      )
        throw new DomainError(
          "MODEL_RUN_EXPIRED",
          "Model run is no longer current / 模型运行已失效",
        );
      await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `model-quota:${groupId}`,
      ]);
      // Expired leases can be reclaimed; the old owner can no longer commit its response.
      await tx.query(
        "update model_requests set state='retry_wait',owner=null,next_attempt_at=now(),reason='MODEL_LEASE_EXPIRED' where group_id=$1 and state in('leased','streaming') and lease_until<=clock_timestamp()",
        [groupId],
      );
      const row = (
        await tx.query("select * from model_requests where id=$1 for update", [this.request.id])
      ).rows[0];
      if (["succeeded", "failed", "cancelled"].includes(row.state)) return { row, owner: null };
      const group = (await tx.query("select * from model_quota_groups where id=$1", [groupId]))
        .rows[0];
      const notBefore = new Date(
        Math.max(
          new Date(row.next_attempt_at).getTime(),
          new Date(group.cooldown_until ?? 0).getTime(),
          new Date(row.lease_until ?? 0).getTime(),
        ),
      );
      if (
        group.cooldown_until &&
        new Date(group.cooldown_until).getTime() > Date.now() &&
        row.state === "queued"
      ) {
        const deferred = (
          await tx.query(
            "update model_requests set state='retry_wait',reason='MODEL_SHARED_COOLDOWN',first_failure_at=coalesce(first_failure_at,now()) where id=$1 returning *",
            [row.id],
          )
        ).rows[0];
        Object.assign(row, deferred);
      }
      if (
        ["queued", "retry_wait"].includes(row.state) &&
        row.first_failure_at &&
        Math.max(Date.now(), notBefore.getTime()) - new Date(row.first_failure_at).getTime() >=
          retryWindowMs
      ) {
        const failed = (
          await tx.query(
            "update model_requests set state='failed',reason='MODEL_COOLDOWN',next_attempt_at=$2,finished_at=now() where id=$1 returning *",
            [row.id, notBefore],
          )
        ).rows[0];
        return { row: failed, owner: null, notBefore };
      }
      const active = Number(
        (
          await tx.query(
            "select count(*) from model_requests where group_id=$1 and lease_until>clock_timestamp()",
            [groupId],
          )
        ).rows[0].count,
      );
      const candidate = (
        await tx.query(
          `select q.id from model_requests q left join model_fairness f on f.group_id=q.group_id and f.conversation_id=q.conversation_id
        where q.group_id=$1 and q.state in ('queued','retry_wait') and q.next_attempt_at<=clock_timestamp()
        and (q.lease_until is null or q.lease_until<=clock_timestamp())
        and (q.run_id is null or exists(select 1 from runs r where r.id=q.run_id and r.state='running' and r.cancel_requested_at is null))
        order by f.served_at nulls first,q.created_at,q.id limit 1`,
          [groupId],
        )
      ).rows[0];
      if (
        active >= group.capacity ||
        (group.cooldown_until && new Date(group.cooldown_until).getTime() > Date.now()) ||
        candidate?.id !== row.id
      )
        return { row, owner: null, notBefore };
      const owner = id("model-lease");
      const claimed = (
        await tx.query(
          "update model_requests set state='leased',owner=$2,lease_until=clock_timestamp()+interval '30 seconds',attempts=attempts+1 where id=$1 returning *",
          [row.id, owner],
        )
      ).rows[0];
      await tx.query(
        "insert into model_fairness(group_id,conversation_id,served_at) values($1,$2,now()) on conflict(group_id,conversation_id) do update set served_at=excluded.served_at",
        [groupId, row.conversation_id],
      );
      return { row: claimed, owner };
    });
  }
  async renew(owner: string) {
    const result = await this.db.pool.query(
      "update model_requests set lease_until=clock_timestamp()+interval '30 seconds',state='streaming' where id=$1 and owner=$2 and lease_until>clock_timestamp() and state in('leased','streaming') and ($3::int is null or exists(select 1 from runs where id=model_requests.run_id and epoch=$3 and state='running' and lease_until>clock_timestamp() and cancel_requested_at is null)) returning id",
      [this.request.id, owner, this.request.runEpoch ?? null],
    );
    if (!result.rowCount)
      throw new DomainError("MODEL_LEASE_LOST", "Model lease expired / 模型请求租约已失效");
  }
  async succeed(owner: string, message: AssistantMessage) {
    const result = await this.db.pool.query(
      "update model_requests set state='succeeded',response=$3,owner=null,lease_until=null,reason=null,finished_at=now() where id=$1 and owner=$2 and lease_until>clock_timestamp() and ($4::int is null or exists(select 1 from runs where id=model_requests.run_id and epoch=$4 and state='running' and lease_until>clock_timestamp() and cancel_requested_at is null)) returning id",
      [this.request.id, owner, JSON.stringify(message), this.request.runEpoch ?? null],
    );
    if (!result.rowCount)
      throw new DomainError(
        "MODEL_LEASE_LOST",
        "Late model response rejected / 已拒绝迟到的模型结果",
      );
  }
  async retry(
    owner: string,
    failure: ModelFailure,
    delay: number,
    retry: boolean,
    quarantine: boolean,
  ) {
    await this.db.transaction(async (tx) => {
      const changed = await tx.query(
        `update model_requests set state=$3,reason=$4,owner=null,
        first_failure_at=coalesce(first_failure_at,now()),next_attempt_at=clock_timestamp()+$5*interval '1 millisecond',lease_until=case when $6 then lease_until else null end,
        finished_at=case when $3='failed' then now() else null end where id=$1 and owner=$2 and lease_until>clock_timestamp()
        and ($7::int is null or exists(select 1 from runs where id=model_requests.run_id and epoch=$7 and state='running' and lease_until>clock_timestamp() and cancel_requested_at is null)) returning group_id`,
        [
          this.request.id,
          owner,
          retry ? "retry_wait" : "failed",
          failure.code,
          delay,
          quarantine,
          this.request.runEpoch ?? null,
        ],
      );
      if (!changed.rowCount)
        throw new DomainError(
          "MODEL_LEASE_LOST",
          "Late model retry rejected / 已拒绝迟到的模型重试",
        );
      if (failure.shared)
        await tx.query(
          "update model_quota_groups set cooldown_until=greatest(coalesce(cooldown_until,now()),clock_timestamp()+$2*interval '1 millisecond') where id=$1",
          [changed.rows[0].group_id, delay],
        );
    });
  }
  async cancel(owner?: string | null) {
    // Aborting transport during worker shutdown is not a user cancellation. Keep
    // the same logical request and its correction budget recoverable after requeue.
    // In both cases the uncertain upstream slot remains occupied until lease expiry.
    await this.db.pool.query(
      `with interrupted as (
        select m.id,($3::int is not null and exists(
          select 1 from runs r where r.id=m.run_id and r.epoch=$3
            and r.cancel_requested_at is null and r.state in ('running','queued','waiting')
        )) as recoverable from model_requests m
        where m.id=$1 and m.state in ('queued','retry_wait','leased','streaming')
          and (m.owner=$2 or (m.owner is null and m.state in ('queued','retry_wait')))
          and ($3::int is null or exists(select 1 from runs r where r.id=m.run_id and r.epoch=$3))
        for update of m
      ) update model_requests m set
        state=case when i.recoverable then 'retry_wait' else 'cancelled' end,
        reason=case when i.recoverable then 'MODEL_INTERRUPTED' else 'MODEL_CANCELLED' end,
        owner=null,finished_at=case when i.recoverable then null else now() end
      from interrupted i where m.id=i.id`,
      [this.request.id, owner ?? null, this.request.runEpoch ?? null],
    );
  }
}
