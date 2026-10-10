import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export type Tx = pg.PoolClient;
export type Sql = Pick<pg.Pool, "query">;
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export const id = (prefix: string) => `${prefix}-${randomUUID()}`;
export function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ),
    )
    .digest("hex");
}
export class Database {
  readonly pool: pg.Pool;
  private listeners = new Map<string, Set<(payload: string) => void>>();
  private listener: pg.Client | undefined;
  private listening: Promise<void> | undefined;
  /** Notifications are hints after commit. Callers retain bounded polling for reconnects. */
  async listen(channel: string, callback: (payload: string) => void) {
    if (!/^[a-z_]+$/.test(channel)) throw new Error("Invalid notification channel");
    const callbacks = this.listeners.get(channel) ?? new Set();
    callbacks.add(callback);
    this.listeners.set(channel, callbacks);
    if (!this.listener) {
      const client = new pg.Client({ connectionString: this.url });
      this.listener = client;
      client.on("notification", (event) => {
        for (const handler of this.listeners.get(event.channel) ?? []) handler(event.payload ?? "");
      });
      client.on("error", () => {
        if (this.listener === client) {
          this.listener = undefined;
          this.listening = undefined;
        }
        void client.end().catch(() => {});
      });
      this.listening = client
        .connect()
        .then(async () => {
          for (const name of this.listeners.keys()) await client.query(`LISTEN ${name}`);
        })
        .catch(async () => {
          if (this.listener === client) this.listener = undefined;
          await client.end().catch(() => {});
        });
    }
    await this.listening;
    await this.listener?.query(`LISTEN ${channel}`).catch(() => {});
    return () => {
      callbacks.delete(callback);
    };
  }
  constructor(readonly url: string) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: 24,
      options: "-c search_path=intrica,public",
      connectionTimeoutMillis: 5000,
    });
    this.pool.on("error", (error) => console.error("[database]", error.message));
  }
  async transaction<T>(fn: (tx: Tx) => Promise<T>, readOnly = false): Promise<T> {
    const tx = await this.pool.connect();
    try {
      await tx.query(readOnly ? "begin isolation level repeatable read read only" : "begin");
      await tx.query("set local statement_timeout='15s'");
      const result = await fn(tx);
      await tx.query("commit");
      return result;
    } catch (error) {
      await tx.query("rollback").catch(() => {});
      throw error;
    } finally {
      tx.release();
    }
  }
  async canvas<T>(
    canvasId: string,
    fn: (tx: Tx) => Promise<T>,
    includeDeleted = false,
  ): Promise<T> {
    return this.transaction(async (tx) => {
      await lockCanvas(tx, canvasId, includeDeleted);
      return fn(tx);
    });
  }
  async migrate(schemaFile?: string): Promise<void> {
    await this.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtextextended('intrica-schema-2',0))");
      await tx.query("create schema if not exists intrica");
      const { rows } = await tx.query("select to_regclass('intrica.schema_info') as name");
      const path =
        schemaFile ?? fileURLToPath(new URL("../../../../../db/schema.sql", import.meta.url));
      if (rows[0].name) {
        let version = (await tx.query("select version from intrica.schema_info")).rows[0]?.version;
        if (version === 2) {
          await tx.query(
            await readFile(join(dirname(path), "migrations/0003-async-tools.sql"), "utf8"),
          );
          version = 3;
        }
        if (version === 3) {
          await tx.query(
            await readFile(join(dirname(path), "migrations/0004-agent-hierarchy.sql"), "utf8"),
          );
          version = 4;
        }
        if (version === 4) {
          await tx.query(
            await readFile(join(dirname(path), "migrations/0005-settings.sql"), "utf8"),
          );
          version = 5;
        }
        if (version === 5) {
          await tx.query(
            await readFile(join(dirname(path), "migrations/0006-approvals.sql"), "utf8"),
          );
          version = 6;
        }
        if (version === 6) {
          await tx.query(
            await readFile(join(dirname(path), "migrations/0007-delegated-resources.sql"), "utf8"),
          );
          version = 7;
        }
        if (version === 7) {
          await tx.query(
            await readFile(join(dirname(path), "migrations/0008-pdf-nodes.sql"), "utf8"),
          );
          version = 8;
        }
        if (version === 8) {
          await tx.query(
            await readFile(
              join(dirname(path), "migrations/0009-conversation-coordination.sql"),
              "utf8",
            ),
          );
          version = 9;
        }
        if (version === 9) {
          const { migrateToolContracts } = await import("./migrations/tool-contracts.js");
          await migrateToolContracts(tx);
          await tx.query(
            await readFile(join(dirname(path), "migrations/0010-tool-contracts.sql"), "utf8"),
          );
          version = 10;
        }
        if (version === 10) {
          await tx.query(
            await readFile(join(dirname(path), "migrations/0011-workflow-controls.sql"), "utf8"),
          );
          version = 11;
        }
        if (version === 11) {
          await tx.query(
            await readFile(join(dirname(path), "migrations/0012-tracing-media.sql"), "utf8"),
          );
          version = 12;
        }
        if (version === 12) {
          await tx.query(
            await readFile(join(dirname(path), "migrations/0013-resource-responses.sql"), "utf8"),
          );
          version = 13;
        }
        if (version !== 13) throw new Error("不支持此数据库版本，请使用独立数据库");
        return;
      }
      await tx.query(await readFile(path, "utf8"));
    });
  }
  async close() {
    await this.listening;
    await this.listener?.end();
    this.listener = undefined;
    await this.pool.end();
  }
}
export async function lockCanvas(tx: Tx, canvasId: string, includeDeleted = false) {
  const { rows } = await tx.query("select * from canvases where id=$1 for update", [canvasId]);
  if (!rows[0] || (!includeDeleted && rows[0].deleted_at))
    throw new DomainError("NOT_FOUND", "画布不存在");
  return rows[0];
}
export async function canvasEvent(
  tx: Tx,
  canvasId: string,
  type: string,
  payload: unknown,
): Promise<string> {
  let encoded = JSON.stringify(payload);
  if (type === "graph.changed" && Buffer.byteLength(encoded) > 256 * 1024) {
    type = "graph.reset";
    encoded = JSON.stringify({ canvasId, reason: "large_change" });
  }
  const { rows } = await tx.query(
    "update canvases set event_seq=event_seq+1 where id=$1 returning event_seq",
    [canvasId],
  );
  const seq = String(rows[0].event_seq);
  await tx.query("insert into canvas_events(canvas_id,seq,type,payload) values($1,$2,$3,$4)", [
    canvasId,
    seq,
    type,
    encoded,
  ]);
  await tx.query("select pg_notify('intrica_changes',$1)", [canvasId]);
  return seq;
}
export async function assertFence(tx: Sql, runId: string, epoch: number): Promise<void> {
  const result = await tx.query(
    "select id from runs where id=$1 and epoch=$2 and state='running' and lease_until>clock_timestamp() and cancel_requested_at is null for update",
    [runId, epoch],
  );
  if (!result.rowCount) throw new DomainError("STALE_EXECUTION", "运行已取消或执行权已失效");
}
