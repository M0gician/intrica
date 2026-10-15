import { DomainError, digest, id, type Sql, type Tx } from "../../../adapters/postgres/database.js";
import { deliveries } from "../messaging/deliveries.js";
import { wakeDependencies } from "./dependencies.js";

export type Obligation = {
  id: string;
  revision: string;
  kind: "incoming" | "outgoing" | "removal";
  text: string;
  dependency: boolean;
  replyTo?: unknown;
};

export async function mailboxState(sql: Sql, conversationId: string) {
  const pending = (await deliveries(sql, conversationId, undefined, true)).filter((q) => q.pending);
  const notices = (
    await sql.query(
      `select client_message_id as id,seq,content from messages where conversation_id=$1
     and role='team_notice' and content->>'event'='member_removed' order by seq`,
      [conversationId],
    )
  ).rows;
  const items: Obligation[] = [
    ...pending
      .filter((q) => q.senderConversationId === conversationId || q.expectReply)
      .map((q) => ({
        id: q.id,
        revision: digest([q.id, q.closed, q.recipientId]),
        kind:
          q.senderConversationId === conversationId ? ("outgoing" as const) : ("incoming" as const),
        text: q.message ?? "",
        dependency:
          q.senderConversationId === conversationId &&
          q.expectReply &&
          !q.closed &&
          !q.paused &&
          !q.blocked,
        ...(q.replyTo ? { replyTo: q.replyTo } : {}),
      })),
    ...notices.map((m) => ({
      id: m.id,
      revision: digest(m.content),
      kind: "removal" as const,
      text: m.content.text ?? "Member removed",
      dependency: false,
    })),
  ];
  const decisions = (
    await sql.query("select * from message_dispositions where conversation_id=$1", [conversationId])
  ).rows;
  const unresolved = items.filter(
    (item) =>
      !decisions.some(
        (d) =>
          d.item_id === item.id &&
          d.revision === item.revision &&
          ((item.kind === "outgoing" && d.action === "background") ||
            (item.kind === "removal" && d.action === "handled")),
      ),
  );
  const boundary = (
    await sql.query(
      `select coalesce(max(seq),0)::text as seq from messages where conversation_id=$1 and
     (role in('user','message','broadcast','trigger','permission_notice','team_notice') or role='tool_update')`,
      [conversationId],
    )
  ).rows[0].seq as string;
  return {
    items: unresolved,
    boundary,
    fingerprint: digest([boundary, unresolved.map((i) => [i.id, i.revision])]),
  };
}

export async function resolveMailboxRef(sql: Sql, conversationId: string, ref: string) {
  const row = (
    await sql.query("select item_id from mailbox_refs where conversation_id=$1 and ref=$2", [
      conversationId,
      ref,
    ])
  ).rows[0];
  return row?.item_id ?? ref;
}

/** Stable scoped references; the cursor freezes ordering, never authorization or live state. */
export async function readInbox(tx: Tx, conversationId: string, cursor?: string) {
  const state = await mailboxState(tx, conversationId);
  let ids: string[];
  if (cursor) {
    const page = (
      await tx.query(
        "select item_ids from mailbox_pages where id=$1 and conversation_id=$2 and expires_at>now()",
        [cursor, conversationId],
      )
    ).rows[0];
    if (!page)
      throw new DomainError(
        "INBOX_CURSOR_EXPIRED",
        "Reopen with read_inbox({}) / 请用 read_inbox({}) 重新读取",
      );
    ids = page.item_ids;
  } else ids = state.items.map((i) => i.id);
  const selected = ids.slice(0, 40).flatMap((key) => {
    const item = state.items.find((candidate) => candidate.id === key);
    return item ? [item] : [];
  });
  const refs = selected.length
    ? (
        await tx.query(
          `insert into mailbox_refs(conversation_id,item_id)
         select $1,item_id from unnest($2::text[]) as item_id
         on conflict(conversation_id,item_id) do update set item_id=excluded.item_id
         returning item_id,ref`,
          [conversationId, [...new Set(selected.map((item) => item.id))]],
        )
      ).rows
    : [];
  const references = new Map(refs.map((row) => [row.item_id, row.ref]));
  const items = selected.map((item) => ({
    ...item,
    ref: references.get(item.id),
    actions:
      item.kind === "outgoing"
        ? ["wait", "background", "expedite", "cancel"]
        : item.kind === "removal"
          ? ["handled"]
          : ["send_message"],
  }));
  const next = ids.length > 40 ? id("inbox-page") : null;
  if (next)
    await tx.query("insert into mailbox_pages(id,conversation_id,item_ids) values($1,$2,$3)", [
      next,
      conversationId,
      ids.slice(40),
    ]);
  await tx.query("delete from mailbox_pages where conversation_id=$1 and expires_at<now()", [
    conversationId,
  ]);
  return {
    items,
    next_cursor: next,
    total: state.items.length,
    wake_dependencies: await wakeDependencies(tx, conversationId),
  };
}

export async function disposeMessage(
  tx: Tx,
  conversationId: string,
  ref: string,
  action: "background" | "handled",
  reason: string,
) {
  const itemId = await resolveMailboxRef(tx, conversationId, ref);
  const item = (await mailboxState(tx, conversationId)).items.find((i) => i.id === itemId);
  if (!item) {
    const prior = (
      await tx.query(
        "select action,reason from message_dispositions where conversation_id=$1 and item_id=$2",
        [conversationId, itemId],
      )
    ).rows[0];
    if (prior?.action === action) return { item_id: itemId, ...prior, changed: false };
    throw new DomainError(
      "MESSAGE_NOT_PENDING",
      "Read current obligations with read_inbox / 用 read_inbox 检查当前待办",
    );
  }
  if (
    !reason.trim() ||
    (action === "background" ? item.kind !== "outgoing" : item.kind !== "removal")
  )
    throw new DomainError(
      "MESSAGE_DISPOSITION",
      "Use an allowed action and explain the disposition / 使用允许的操作并说明处理结果",
    );
  await tx.query(
    `insert into message_dispositions(conversation_id,item_id,revision,action,reason) values($1,$2,$3,$4,$5)
    on conflict(conversation_id,item_id) do update set revision=excluded.revision,action=excluded.action,reason=excluded.reason,updated_at=now()`,
    [conversationId, item.id, item.revision, action, reason],
  );
  return { item_id: item.id, action, changed: true };
}
