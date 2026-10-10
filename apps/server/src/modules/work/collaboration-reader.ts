import type { Database } from "../../adapters/postgres/database.js";
import { projectMessageReceipts } from "../collaboration/receipts.js";

export class CollaborationReader {
  constructor(private readonly db: Database) {}

  async history(agentId: string, viewerId: string, before?: number) {
    const rows = (
      await this.db.pool.query(
        `select m.seq,m.role,m.content,m.run_id,m.consumed_run_id,m.created_at,c.id as conversation_id,c.consumed_message_seq,
        r.state as run_state
       from messages m join conversations c on c.id=m.conversation_id left join runs r on r.id=coalesce(m.consumed_run_id,m.run_id)
       where c.agent_id=$1 and ($3::bigint is null or m.seq<$3)
       and m.role in ('message','report','broadcast','run_status','context_notice')
       and (m.content->>'from'=$2 or m.content->>'to'=$2 or m.content->'recipients' ? $2)
       order by m.seq desc limit 81`,
        [agentId, viewerId, before ?? null],
      )
    ).rows;
    const page = rows.slice(0, 80).reverse();
    for (const row of page) await projectMessageReceipts(this.db.pool, [row], row.conversation_id);
    return {
      events: page.map((row) => ({
        conversationId: row.conversation_id,
        seq: Number(row.seq),
        agentId,
        kind: row.role,
        data: row.content,
        createdAt: new Date(row.created_at).toISOString(),
        ...(row.role === "message" && row.content.from === viewerId
          ? {
              receipt: {
                status: row.content.closed
                  ? "closed"
                  : row.content.activationBlocked
                    ? "blocked"
                    : row.consumed_run_id
                      ? "consumed"
                      : !row.content.workItemId &&
                          BigInt(row.seq) <= BigInt(row.consumed_message_seq)
                        ? "closed"
                        : "queued",
                runId: row.consumed_run_id ?? row.run_id,
                runState: row.run_state,
              },
            }
          : {}),
      })),
      nextBefore: rows.length > 80 ? Number(page[0].seq) : null,
    };
  }
}
