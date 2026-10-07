import type { CanvasNavigationIndex, ConversationPreview } from "@intrica/contracts";
import { type Database, DomainError } from "../../adapters/postgres/database.js";

export type CanvasMessageScope = [
  canvasId: string,
  selection: string[] | null,
  group: string[] | null,
];
export type CanvasMessagePage = {
  before?: string | undefined;
  after?: string | undefined;
  around?: string | undefined;
};
const sender = "coalesce(m.content->>'senderId',c.agent_id,r.frozen_input->>'agentId')";
const source = `from messages m join conversations c on c.id=m.conversation_id left join runs r on r.id=m.run_id
  where c.canvas_id=$1 and (m.role in ('broadcast','report') or (m.role='message' and not(m.content ? 'from')))
  and ($2::text[] is null or ${sender}=any($2) or m.content->'recipients' ?| $2 or m.content->>'to'=any($2))
  and ($3::text[] is null or ${sender}=any($3) or m.content->'recipients' ?| $3 or m.content->>'to'=any($3))`;
const keyOf = (row: any) => `${row.conversation_id}:${row.seq}`;

export class CanvasMessages {
  constructor(private readonly db: Database) {}

  private async query(
    scope: CanvasMessageScope,
    fields: string,
    limit: number,
    order: "asc" | "desc",
    key?: string,
    operator: "<" | ">" | ">=" | "=" = ">",
  ) {
    const split = key?.lastIndexOf(":") ?? -1;
    const conversationId = key?.slice(0, split);
    const seq = key === undefined ? null : Number(key.slice(split + 1));
    if (key !== undefined && (!conversationId || !Number.isSafeInteger(seq) || seq! < 1))
      throw new DomainError("VALIDATION", "Invalid message cursor");
    return (
      await this.db.pool.query(
        `select ${fields} ${source}
       and ($4::text is null or (m.created_at,m.conversation_id,m.seq) ${operator}
         (select x.created_at,x.conversation_id,x.seq from messages x where x.conversation_id=$4 and x.seq=$5))
       order by m.created_at ${order},m.conversation_id ${order},m.seq ${order} limit $6`,
        [...scope, conversationId ?? null, seq, limit],
      )
    ).rows;
  }

  async page(scope: CanvasMessageScope, page: CanvasMessagePage = {}) {
    if ([page.before, page.after, page.around].filter((key) => key !== undefined).length > 1)
      throw new DomainError("VALIDATION", "Use one message cursor");
    const forward = page.after !== undefined || page.around !== undefined;
    const rows = await this.query(
      scope,
      `m.*,coalesce(${sender},case when r.frozen_input ? 'agentId' then 'workspace' else 'unknown' end) as agent_id`,
      100,
      forward ? "asc" : "desc",
      page.before ?? page.after ?? page.around,
      page.before ? "<" : page.around ? ">=" : ">",
    );
    if (page.around !== undefined && !rows.some((row) => keyOf(row) === page.around))
      throw new DomainError("NOT_FOUND", "Collaboration message not found");
    if (!forward) rows.reverse();
    const first = rows[0],
      last = rows.at(-1);
    const [earlier, later] =
      first && last
        ? await Promise.all([
            this.query(scope, "m.seq", 1, "desc", keyOf(first), "<"),
            this.query(scope, "m.seq", 1, "asc", keyOf(last), ">"),
          ])
        : [[], []];
    return {
      events: rows.map((r) => ({
        conversationId: r.conversation_id,
        seq: Number(r.seq),
        agentId: r.agent_id,
        kind: r.role,
        data: r.content,
        createdAt: r.created_at,
      })),
      nextBefore: earlier.length ? keyOf(first) : null,
      nextAfter: later.length ? keyOf(last) : null,
    };
  }

  async index(scope: CanvasMessageScope, after?: string): Promise<CanvasNavigationIndex> {
    const rows = await this.query(scope, "m.conversation_id,m.seq", 513, "asc", after);
    const revision =
      (await this.db.pool.query("select event_seq from canvases where id=$1", [scope[0]])).rows[0]
        ?.event_seq ?? 0;
    const items = rows.slice(0, 512).map(keyOf);
    return {
      items,
      nextAfter: rows.length > 512 ? items.at(-1)! : null,
      revision: Number(revision),
    };
  }

  async preview(scope: CanvasMessageScope, key: string): Promise<ConversationPreview> {
    const row = (
      await this.query(
        scope,
        `m.seq,${sender} as sender_id,m.content->>'senderName' as sender_name,
      m.content->'recipientNames' as recipient_names,m.content->'resourceIds' as resource_ids,
      case when m.content ? 'to' then jsonb_build_array(m.content->>'to') else m.content->'recipients' end as recipient_ids,
      left(coalesce(m.content->>'text',''),240) as text`,
        1,
        "asc",
        key,
        "=",
      )
    )[0];
    if (!row) throw new DomainError("NOT_FOUND", "Collaboration message not found");
    const recipients: string[] = row.recipient_ids ?? [];
    const resources: string[] = row.resource_ids ?? [];
    const names = (
      await this.db.pool.query(
        "select id,body->>'title' as title from nodes where canvas_id=$1 and id=any($2::text[])",
        [scope[0], [row.sender_id, ...recipients, ...resources.slice(0, 2)]],
      )
    ).rows;
    const name = (id: string) =>
      names.find((node) => node.id === id)?.title ||
      (id === row.sender_id ? row.sender_name : row.recipient_names?.[id]) ||
      id;
    return {
      seq: Number(row.seq),
      kind: "message",
      title: [row.sender_id && name(row.sender_id), recipients.map(name).join(", ")]
        .filter(Boolean)
        .join(" → ")
        .slice(0, 240),
      excerpt: row.text,
      artifacts: {
        items: resources.slice(0, 2).map((id) => ({ id, label: name(id).slice(0, 80) })),
        total: resources.length,
      },
    };
  }
}
