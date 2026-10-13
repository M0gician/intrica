import type { InboxDecision, InboxReviewArgs } from "@intrica/contracts";
import { DomainError, digest, id, type Sql, type Tx } from "../../../adapters/postgres/database.js";
import { actionableMessage } from "../../execution/messages.js";
import { deliveries } from "./deliveries.js";

type Item = {
  id: string;
  kind: "message" | "incoming" | "outgoing";
  text: string | null;
  deliveryId?: string;
  seq?: string;
  expectReply?: boolean;
  readAt?: Date | null;
  allowedActions: InboxDecision["action"][];
};

export async function reviewState(sql: Sql, conversationId: string) {
  const messages = (
    await sql.query(
      `select m.client_message_id as id,m.seq,m.role,left(m.content->>'text',800) as text,
    m.consumed_at as "readAt" from messages m where m.conversation_id=$1
    and (m.role in('user','trigger') or (m.role='message' and m.content ? 'from')
      or (m.role in('message_notice','team_notice','permission_notice') and ${actionableMessage}))
    and m.seq>coalesce((select reviewed_seq from inbox_reviews where conversation_id=$1),0) order by m.seq`,
      [conversationId],
    )
  ).rows;
  const pending = (await deliveries(sql, conversationId, undefined, true)).filter((q) => q.pending);
  const relevant = pending.filter(
    (q) => q.senderConversationId === conversationId || q.expectReply,
  );
  const items: Item[] = [
    ...messages.map((m) => ({
      id: `message:${m.id}`,
      kind: "message" as const,
      text: m.text,
      seq: m.seq,
      allowedActions: ["handled" as const],
    })),
    ...relevant.map((q) => ({
      id: `delivery:${q.id}`,
      kind: (q.senderConversationId === conversationId ? "outgoing" : "incoming") as
        | "outgoing"
        | "incoming",
      deliveryId: q.id,
      text: q.message,
      expectReply: q.expectReply,
      readAt: q.readAt,
      allowedActions:
        q.senderConversationId === conversationId
          ? ["wait" as const, "background" as const]
          : ["wait" as const],
    })),
  ];
  const fingerprint = digest({
    messages: messages.map((m) => [m.id, m.seq]),
    deliveries: relevant.map((q) => [
      q.id,
      q.version,
      q.readAt,
      q.notified_at,
      q.unread_notified_at,
    ]),
  });
  return { items, messages, deliveries: relevant, fingerprint };
}

export async function reviewInbox(tx: Tx, conversationId: string, args: InboxReviewArgs) {
  const state = await reviewState(tx, conversationId);
  if (args.action === "inspect") {
    const prior = (
      await tx.query(
        "select inspection_token,inspection_fingerprint from inbox_reviews where conversation_id=$1",
        [conversationId],
      )
    ).rows[0];
    const reviewId =
      prior?.inspection_fingerprint === state.fingerprint ? prior.inspection_token : id("review");
    await tx.query(
      `insert into inbox_reviews(conversation_id,token,fingerprint,inspection_token,inspection_fingerprint)
      values($1,'','',$2,$3) on conflict(conversation_id) do update set inspection_token=excluded.inspection_token,inspection_fingerprint=excluded.inspection_fingerprint`,
      [conversationId, reviewId, state.fingerprint],
    );
    const after = args.after ?? 0;
    return {
      reviewId,
      items: state.items.slice(after, after + 80),
      total: state.items.length,
      nextAfter: after + 80 < state.items.length ? after + 80 : null,
      incoming: state.deliveries.filter((q) => q.recipientConversationId === conversationId),
      outgoing: state.deliveries.filter((q) => q.senderConversationId === conversationId),
      nextAction:
        "逐项检查。需要回复的来信先使用 replyTo 答复，再重新 inspect。confirm 必须携带 reviewId 和完整 decisions；background 仅用于不影响当前任务的发信，必须说明 reason。",
    };
  }
  if (args.action !== "confirm" || !args.reviewId || !Array.isArray(args.decisions))
    throw new DomainError(
      "INBOX_REVIEW_INPUT",
      "确认需要 action=confirm、reviewId 和 decisions；空信箱传 decisions=[]",
      { path: "decisions", executed: false },
    );
  const inspection = (
    await tx.query(
      "select inspection_token,inspection_fingerprint from inbox_reviews where conversation_id=$1",
      [conversationId],
    )
  ).rows[0];
  if (
    inspection?.inspection_token !== args.reviewId ||
    inspection.inspection_fingerprint !== state.fingerprint
  )
    throw new DomainError("INBOX_REVIEW_REQUIRED", "信箱已变化，请重新 inspect 后确认", {
      hook: "review_inbox",
      nextAction: 'review_inbox({action:"inspect"})',
    });
  const seen = new Set<string>();
  for (const decision of args.decisions) {
    const item = state.items.find((i) => i.id === decision.itemId);
    if (!item || seen.has(decision.itemId) || !item.allowedActions.includes(decision.action))
      throw new DomainError(
        "INBOX_REVIEW_INPUT",
        "itemId 和 action 必须来自当前检查结果，且每项只能确认一次",
        {
          path: "decisions",
          itemId: decision.itemId,
          allowedActions: item?.allowedActions,
          executed: false,
        },
      );
    if (decision.action === "background" && !decision.reason?.trim())
      throw new DomainError("INBOX_REVIEW_INPUT", "后台跟踪需要说明此消息为何不影响当前任务完成", {
        path: "decisions.reason",
        itemId: decision.itemId,
      });
    seen.add(decision.itemId);
  }
  const missing = state.items.filter((i) => !seen.has(i.id));
  if (missing.length)
    throw new DomainError("INBOX_REVIEW_INCOMPLETE", "复核未覆盖全部待处理项", {
      missingItems: missing.slice(0, 80),
      nextAction: "沿 nextAfter 读取全部项目，再提交完整 decisions。",
    });
  const token = id("inbox-review");
  const reviewedSeq =
    state.messages.at(-1)?.seq ??
    (
      await tx.query("select reviewed_seq as seq from inbox_reviews where conversation_id=$1", [
        conversationId,
      ])
    ).rows[0]?.seq ??
    0;
  await tx.query(
    `update inbox_reviews set token=$2,reviewed_seq=$3,decisions=$4,reviewed_at=now() where conversation_id=$1`,
    [conversationId, token, reviewedSeq, JSON.stringify(args.decisions)],
  );
  const current = await reviewState(tx, conversationId);
  await tx.query("update inbox_reviews set fingerprint=$2 where conversation_id=$1", [
    conversationId,
    current.fingerprint,
  ]);
  return {
    reviewed: true,
    reviewToken: token,
    completion: args.decisions.some((d) => d.action === "wait") ? "waiting" : "ready",
  };
}

export async function reviewStatus(sql: Sql, conversationId: string) {
  const state = await reviewState(sql, conversationId);
  const review = (
    await sql.query("select * from inbox_reviews where conversation_id=$1", [conversationId])
  ).rows[0];
  const fresh = Boolean(review?.token && review.fingerprint === state.fingerprint);
  const waiting =
    fresh &&
    (review.decisions as InboxDecision[]).some(
      (d) => d.action === "wait" && state.items.some((i) => i.id === d.itemId),
    );
  return { state, review, fresh, waiting };
}

export async function confirmWait(
  tx: Tx,
  conversationId: string,
  confirmed?: boolean,
  token?: string,
) {
  const { review, fresh } = await reviewStatus(tx, conversationId);
  if (!confirmed || !token || review?.token !== token || !fresh)
    throw new DomainError(
      "INBOX_REVIEW_REQUIRED",
      "等待前必须复核收发信箱；新输入或状态变化后重新检查",
      {
        executed: false,
        hook: "review_inbox",
        nextAction:
          'review_inbox({action:"inspect"})，确认后使用 wait_for_message({confirmed:true,reviewToken})。',
      },
    );
  return { waitingForMessage: true, reviewed: true };
}
