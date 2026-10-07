import type { ExecutionOverview, UsageReport } from "@intrica/contracts";
import { type Database, DomainError } from "../../adapters/postgres/database.js";
import type { ExecutionSettingsStore } from "./settings.js";
export class Statistics {
  constructor(
    readonly db: Database,
    readonly settings: ExecutionSettingsStore,
  ) {}
  async liveSummary() {
    const [overview, approvals] = await Promise.all([
      this.overview(),
      this.db.pool.query(
        "select count(*)::int as count from approvals a join canvases c on c.id=a.canvas_id where a.status='pending' and a.expires_at>now() and c.deleted_at is null",
      ),
    ]);
    return {
      agents: overview.agents,
      queued: overview.queued,
      pendingApprovals: approvals.rows[0].count as number,
      unknownTools: overview.unknownTools,
    };
  }
  async overview(): Promise<ExecutionOverview> {
    return this.db.transaction(async (tx) => {
      const { policy } = await this.settings.read(tx);
      const counts = (
        await tx.query(
          `select count(*) filter(where state='running' and lease_until>now() and kind='conversation')::int as agents,count(*) filter(where state='running' and lease_until>now() and kind='generation')::int as generations,count(*) filter(where state='queued')::int as queued,count(*) filter(where state='waiting')::int as waiting from runs`,
        )
      ).rows[0];
      const tools = (
        await tx.query(
          `select count(*) filter(where t.state='dispatching' and r.state='running' and r.lease_until>now())::int as tools,count(*) filter(where t.state='unknown')::int as "unknownTools" from tool_calls t join runs r on r.id=t.run_id`,
        )
      ).rows[0];
      return { ...counts, ...tools, policy };
    }, true);
  }
  async usage(input: {
    from: string;
    to: string;
    canvasId?: string;
    groupBy?: "model" | "endpoint" | "purpose";
  }): Promise<UsageReport> {
    const from = new Date(input.from),
      to = new Date(input.to);
    if (
      !Number.isFinite(+from) ||
      !Number.isFinite(+to) ||
      +to <= +from ||
      +to - +from > 366 * 86400000
    )
      throw new DomainError("VALIDATION", "Select a time range of at most one year");
    const group = {
      model: "provider || '/' || model_id",
      endpoint: "coalesce(endpoint_id,'builtin')",
      purpose: "purpose",
    }[input.groupBy ?? "model"];
    return this.db.transaction(async (tx) => {
      const params = [from, to, input.canvasId ?? null];
      const rows = (
        await tx.query(
          `select ${group} as name,simulated,count(*)::int as calls,count(*) filter(where usage_status='reported')::int as reported,count(*) filter(where finished_at is null)::int as unfinished,sum(input_tokens)::float8 as "inputTokens",sum(output_tokens)::float8 as "outputTokens",sum(cache_read_tokens)::float8 as "cacheReadTokens",sum(cache_write_tokens)::float8 as "cacheWriteTokens" from model_calls where started_at >=$1 and started_at<$2 and ($3::text is null or canvas_id=$3) group by 1,simulated order by 1,simulated`,
          params,
        )
      ).rows;
      const counts = (
        await tx.query(
          `select count(*) filter(where state='succeeded')::int as completed,count(*) filter(where state='failed')::int as failed,count(*) filter(where state='cancelled')::int as cancelled from runs where updated_at>=$1 and updated_at<$2 and ($3::text is null or canvas_id=$3)`,
          params,
        )
      ).rows[0];
      const since = (await tx.query("select initialized_at from execution_settings")).rows[0]
        .initialized_at;
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        collectedSince: since.toISOString(),
        ...counts,
        rows,
      };
    }, true);
  }
}
