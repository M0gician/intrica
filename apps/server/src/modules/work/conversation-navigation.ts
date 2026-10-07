import type { ConversationNavigationIndex, ConversationPreview } from "@intrica/contracts";
import { type Database, DomainError } from "../../adapters/postgres/database.js";

const anchor = `(role in ('user','trigger','report','team_notice','context_notice')
  or (role='run_status' and content->>'category' in ('failed','unknown','turn_limit'))
  or (role='status' and content->>'reason' in ('unknown','turn_limit'))
  or (role='message' and content ? 'from'))`;

export class ConversationNavigation {
  constructor(private readonly db: Database) {}

  async index(conversationId: string, after: number): Promise<ConversationNavigationIndex> {
    const rows = (
      await this.db.pool.query(
        `select seq from messages where conversation_id=$1 and ${anchor} and seq>$2 order by seq limit 513`,
        [conversationId, after],
      )
    ).rows;
    const revision =
      (
        await this.db.pool.query("select message_seq from conversations where id=$1", [
          conversationId,
        ])
      ).rows[0]?.message_seq ?? 0;
    const items = rows.slice(0, 512).map((row) => Number(row.seq));
    return {
      items,
      nextAfter: rows.length > 512 ? items.at(-1)! : null,
      revision: Number(revision),
    };
  }

  async preview(conversationId: string, seq: number): Promise<ConversationPreview> {
    return this.db.transaction(async (tx) => {
      const entry = (
        await tx.query(
          `select role,left(coalesce(content->>'text',content->>'reason',''),240) as text,
          (select min(seq) from messages where conversation_id=$1 and ${anchor} and seq>$2) as next_seq
         from messages where conversation_id=$1 and seq=$2 and ${anchor}`,
          [conversationId, seq],
        )
      ).rows[0];
      if (!entry) throw new DomainError("NOT_FOUND", "Conversation entry not found");
      const reply = (
        await tx.query(
          `select left(content->>'text',240) as text from messages
         where conversation_id=$1 and seq>$2 and ($3::bigint is null or seq<$3)
         and role='assistant' and length(content->>'text')>0 order by seq limit 1`,
          [conversationId, seq, entry.next_seq],
        )
      ).rows[0];
      const artifacts = (
        await tx.query(
          `select t.id,left(t.args->>'title',80) as title,count(*) over()::int as total
         from messages m join tool_calls t on t.id=m.content->>'callId'
         where m.conversation_id=$1 and m.seq>$2 and ($3::bigint is null or m.seq<$3)
         and m.role='tool' and t.name='create_artifact' and t.state='succeeded'
         order by m.seq limit 2`,
          [conversationId, seq, entry.next_seq],
        )
      ).rows;
      return {
        seq,
        kind: ["user", "trigger", "message"].includes(entry.role)
          ? "input"
          : entry.role === "report"
            ? "report"
            : "status",
        title: entry.text,
        excerpt: ["user", "trigger", "message"].includes(entry.role)
          ? (reply?.text ?? "")
          : entry.text,
        artifacts: {
          items: artifacts.map((row) => ({ id: row.id, label: row.title })),
          total: artifacts[0]?.total ?? 0,
        },
      };
    }, true);
  }
}
