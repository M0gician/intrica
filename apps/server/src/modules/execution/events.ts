import { applyMessage, type StreamMessage } from "@intrica/contracts";
import { type Database, DomainError } from "../../adapters/postgres/database.js";
export type EventRecord = { seq: string; type: string; payload: any; attemptId?: string | null };
export class Events {
  constructor(readonly db: Database) {}
  async messageAt(runId: string, before?: string): Promise<StreamMessage | undefined> {
    const last = (
      await this.db.pool.query(
        "select seq,payload from run_events where run_id=$1 and type='message' and ($2::bigint is null or seq<=$2) order by seq desc limit 1",
        [runId, before ?? null],
      )
    ).rows[0];
    if (!last) return;
    if (!last.payload.delta) return last.payload;
    const snapshot = (
      await this.db.pool.query(
        "select seq,payload from run_events where run_id=$1 and type='message' and payload->>'id'=$2 and seq<=$3 and payload->>'delta' is distinct from 'true' order by seq desc limit 1",
        [runId, last.payload.id, last.seq],
      )
    ).rows[0];
    if (!snapshot) throw new DomainError("RESET_REQUIRED", "流内容快照已过期");
    const updates = (
      await this.db.pool.query(
        "select payload from run_events where run_id=$1 and type='message' and payload->>'id'=$2 and seq>$3 and seq<=$4 order by seq",
        [runId, last.payload.id, snapshot.seq, last.seq],
      )
    ).rows;
    let message = snapshot.payload;
    for (const update of updates) message = applyMessage(message, update.payload);
    return message;
  }
  async prune() {
    await this.db.pool.query(
      "delete from canvas_events where (canvas_id,seq) in(select canvas_id,seq from canvas_events where created_at<now()-interval '7 days' order by created_at limit 5000)",
    );
    await this.db.pool.query(
      "delete from run_events where (run_id,seq) in(select e.run_id,e.seq from run_events e join runs r on r.id=e.run_id where e.created_at<now()-interval '7 days' and r.state in('succeeded','failed','cancelled') order by e.created_at limit 5000)",
    );
    await this.db.pool.query(
      "update commands set undo_patch=null where id in(select id from commands where undo_patch is not null and created_at<now()-interval '30 days' order by created_at limit 500)",
    );
  }
  async read(
    topic: "canvas" | "run",
    entityId: string,
    after: string,
    limit = 200,
  ): Promise<EventRecord[]> {
    if (!/^\d+$/.test(after)) throw new DomainError("VALIDATION", "事件游标无效");
    const table = topic === "canvas" ? "canvas_events" : "run_events",
      column = topic === "canvas" ? "canvas_id" : "run_id";
    const records = (
      await this.db.pool.query(
        `select * from ${table} where ${column}=$1 and seq>$2 order by seq limit $3`,
        [entityId, after, limit],
      )
    ).rows;
    return records.map((r) => ({
      seq: String(r.seq),
      type: r.type,
      payload: r.payload,
      ...(topic === "run" ? { attemptId: r.attempt_id } : {}),
    }));
  }
  async validate(topic: "canvas" | "run", entityId: string, after: string) {
    const table = topic === "canvas" ? "canvas_events" : "run_events",
      column = topic === "canvas" ? "canvas_id" : "run_id";
    if (!/^\d+$/.test(after)) throw new DomainError("VALIDATION", "事件游标无效");
    const entity = (
      await this.db.pool.query(
        topic === "canvas"
          ? "select event_seq as seq from canvases where id=$1"
          : "select last_event_seq as seq from runs where id=$1",
        [entityId],
      )
    ).rows[0];
    if (!entity) throw new DomainError("NOT_FOUND", "事件对象不存在");
    if (BigInt(after) > BigInt(entity.seq))
      throw new DomainError("RESET_REQUIRED", "事件游标超过当前实例进度");
    const row = (
      await this.db.pool.query(`select min(seq)::text as min from ${table} where ${column}=$1`, [
        entityId,
      ])
    ).rows[0];
    if (
      (row.min && BigInt(after) < BigInt(row.min) - 1n) ||
      (!row.min && BigInt(after) < BigInt(entity.seq))
    )
      throw new DomainError("RESET_REQUIRED", "事件保留窗口已过期，请重新加载");
  }
}
