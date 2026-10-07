import type { ExecutionPolicy, ExecutionSettings } from "@intrica/contracts";
import { type Database, DomainError, type Sql } from "../../adapters/postgres/database.js";
import type { ExecutionLimits } from "./limits.js";

export class ExecutionSettingsStore {
  constructor(
    readonly db: Database,
    readonly defaults: ExecutionLimits,
  ) {}
  async initialize() {
    const { agents, generations, generationsPerCanvas, pendingPerCanvas, toolsPerAgent, tools } =
      this.defaults;
    await this.db.pool.query(
      "insert into execution_settings(id,policy) values(true,$1) on conflict do nothing",
      [
        JSON.stringify({
          agents,
          generations,
          generationsPerCanvas,
          pendingPerCanvas,
          toolsPerAgent,
          tools,
        }),
      ],
    );
  }
  async read(sql: Sql = this.db.pool, lock = false): Promise<ExecutionSettings> {
    return (
      await sql.query(
        `select revision,policy from execution_settings where id=true${lock ? " for share" : ""}`,
      )
    ).rows[0];
  }
  async limits(sql: Sql = this.db.pool, lock = false): Promise<ExecutionLimits> {
    return { ...this.defaults, ...(await this.read(sql, lock)).policy };
  }
  async save(expectedRevision: number, policy: ExecutionPolicy): Promise<ExecutionSettings> {
    if (policy.generationsPerCanvas > policy.generations || policy.toolsPerAgent > policy.tools)
      throw new DomainError(
        "VALIDATION",
        "Per-canvas and per-agent limits cannot exceed server limits",
      );
    const result = await this.db.pool.query(
      "update execution_settings set policy=$2,revision=revision+1,updated_at=now() where id=true and revision=$1 returning revision,policy",
      [expectedRevision, JSON.stringify(policy)],
    );
    if (!result.rowCount)
      throw new DomainError("VERSION_CONFLICT", "Settings changed on another client");
    return result.rows[0];
  }
}
