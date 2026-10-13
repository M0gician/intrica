import {
  canvasEvent,
  type Database,
  DomainError,
  digest,
  id,
  type Sql,
  type Tx,
} from "../../adapters/postgres/database.js";
import { agentIdentity, collaborationNeedsApproval } from "../access/policy.js";
import { actionableMessage, collaborationIdentity } from "../execution/messages.js";
import type { Run } from "../execution/store.js";
import type { Conversations } from "./conversations.js";

export async function expectReply(
  tx: Tx,
  run: Run,
  senderId: string | null,
  recipient: any,
  callId: string,
  seconds: number,
) {
  const requestId = id("message-request");
  const messageId = `delivery-${callId}-${recipient.agent_id}`;
  return (
    await tx.query(
      `insert into message_requests(id,canvas_id,sender_conversation_id,recipient_conversation_id,
      sender_agent_id,recipient_agent_id,origin_call_id,inbox_message_id,deadline_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+$9*interval '1 second')
     on conflict(origin_call_id,recipient_conversation_id) do update set origin_call_id=excluded.origin_call_id returning id`,
      [
        requestId,
        run.canvas_id,
        run.subject_id,
        recipient.id,
        senderId,
        recipient.agent_id,
        callId,
        messageId,
        seconds,
      ],
    )
  ).rows[0].id as string;
}

export async function replyAddress(sql: Sql, conversationId: string, requestId: string) {
  const request = (
    await sql.query("select * from message_requests where id=$1 and recipient_conversation_id=$2", [
      requestId,
      conversationId,
    ])
  ).rows[0];
  if (!request)
    throw new DomainError(
      "MESSAGE_TARGET",
      "id 必须是发给当前会话的 requestId；使用 review_inbox 返回的回复地址",
      { path: "id", executed: false },
    );
  if (request.state !== "open")
    throw new DomainError(
      "MESSAGE_CLOSED",
      `此请求已${request.state === "replied" ? "回复" : "取消"}；新消息请使用 agent 目标`,
      { path: "id", executed: false },
    );
  return request;
}

export async function completeReply(
  tx: Tx,
  conversationId: string,
  requestId: string,
  callId: string,
) {
  await replyAddress(tx, conversationId, requestId);
  await tx.query(
    "update message_requests set state='replied',reply_call_id=$2,version=version+1,updated_at=now() where id=$1",
    [requestId, callId],
  );
}

export class MessageHooks {
  constructor(
    readonly db: Database,
    readonly conversations: Conversations,
  ) {}

  async requests(sql: Sql, conversationId: string) {
    const rows = (
      await sql.query(
        `select q.id,q.state,q.version,q.deadline_at as "deadlineAt",q.notified_at as "notifiedAt",
       q.sender_conversation_id as "senderConversationId",q.recipient_conversation_id as "recipientConversationId",
       q.sender_agent_id as "senderId",q.recipient_agent_id as "recipientId",
       q.inbox_message_id as "messageId",sender.body->>'title' as "senderName",n.body->>'title' as "recipientName",
       m.consumed_at as "readAt",left(m.content->>'text',500) as message,
       (select r.state from runs r where r.subject_id=q.recipient_conversation_id order by r.created_at desc,r.id desc limit 1) as "runState"
      from message_requests q left join nodes n on n.id=q.recipient_agent_id left join nodes sender on sender.id=q.sender_agent_id
      left join messages m on m.conversation_id=q.recipient_conversation_id and m.client_message_id=q.inbox_message_id
      where q.sender_conversation_id=$1 or q.recipient_conversation_id=$1 order by q.created_at,q.id`,
        [conversationId],
      )
    ).rows;
    return rows.map((q) => ({
      ...q,
      ...(q.recipientConversationId === conversationId && q.state === "open"
        ? { replyTo: { to: "request", id: q.id } }
        : {}),
    }));
  }

  private async reviewState(sql: Sql, conversationId: string) {
    const messages = (
      await sql.query(
        `select m.client_message_id as id,m.seq,m.role,left(m.content->>'text',800) as text,
       m.content->>'requestId' as "requestId",m.consumed_at as "readAt"
       from messages m where m.conversation_id=$1 and
       (m.role in('user','trigger','message','report','task','broadcast') or (m.role in('message_notice','team_notice','permission_notice') and ${actionableMessage}))
       and m.seq>coalesce((select reviewed_seq from inbox_reviews where conversation_id=$1),0)
       order by m.seq`,
        [conversationId],
      )
    ).rows;
    const requests = (await this.requests(sql, conversationId)).filter((q) => q.state === "open");
    const fingerprint = digest({
      messages: messages.map((m) => [m.id, m.seq]),
      requests: requests.map((q) => [q.id, q.version, Boolean(q.notifiedAt)]),
    });
    return { messages, requests, fingerprint };
  }

  async review(
    tx: Tx,
    conversationId: string,
    args: {
      handledMessageIds?: string[];
      trackRequestIds?: string[];
      reviewKey?: string;
      after?: number;
    },
  ) {
    const state = await this.reviewState(tx, conversationId);
    const incoming = state.requests.filter((q) => q.recipientConversationId === conversationId);
    const outgoing = state.requests.filter((q) => q.senderConversationId === conversationId);
    const page = state.messages.filter((m) => Number(m.seq) > (args.after ?? 0)).slice(0, 80);
    const projection = {
      incoming,
      outgoing,
      messages: page,
      nextAfter:
        page.length && state.messages.some((m) => Number(m.seq) > Number(page.at(-1).seq))
          ? Number(page.at(-1).seq)
          : null,
    };
    if (args.handledMessageIds === undefined || args.trackRequestIds === undefined) {
      const prior = (
        await tx.query(
          "select inspection_token,inspection_fingerprint from inbox_reviews where conversation_id=$1",
          [conversationId],
        )
      ).rows[0];
      const key =
        prior?.inspection_fingerprint === state.fingerprint
          ? prior.inspection_token
          : id("inbox-inspection");
      await tx.query(
        `insert into inbox_reviews(conversation_id,token,fingerprint,inspection_token,inspection_fingerprint)
        values($1,'','',$2,$3) on conflict(conversation_id) do update set inspection_token=excluded.inspection_token,inspection_fingerprint=excluded.inspection_fingerprint`,
        [conversationId, key, state.fingerprint],
      );
      return {
        ...projection,
        reviewRequired: true,
        reviewKey: key,
        nextAction:
          "回复需要答复的请求；明确列出已处理的 message IDs 和继续跟踪的 request IDs，再携带 reviewKey 调用 review_inbox。信箱变化后重新读取。",
      };
    }
    const inspection = (
      await tx.query(
        "select inspection_token,inspection_fingerprint from inbox_reviews where conversation_id=$1",
        [conversationId],
      )
    ).rows[0];
    if (
      !args.reviewKey ||
      inspection?.inspection_token !== args.reviewKey ||
      inspection.inspection_fingerprint !== state.fingerprint
    )
      throw new DomainError(
        "INBOX_REVIEW_REQUIRED",
        "先读取当前信箱，再携带返回的 reviewKey 提交复核",
        { hook: "review_inbox", nextAction: "调用 review_inbox({})；信箱或请求变化后重新读取。" },
      );
    const tracked = new Set(args.trackRequestIds),
      handled = new Set(args.handledMessageIds);
    const unknownMessages = [...handled].filter((id) => !state.messages.some((m) => m.id === id));
    const unknownRequests = [...tracked].filter((id) => !state.requests.some((q) => q.id === id));
    if (unknownMessages.length || unknownRequests.length)
      throw new DomainError(
        "INBOX_REVIEW_INPUT",
        "仅可确认当前 review_inbox 返回的消息和未结请求",
        {
          unknownMessageIds: unknownMessages.slice(0, 80),
          unknownRequestIds: unknownRequests.slice(0, 80),
        },
      );
    const missingRequests = state.requests.filter((q) => !tracked.has(q.id)).map((q) => q.id);
    const missingMessages = state.messages
      .filter((m) => !handled.has(m.id) && !tracked.has(m.requestId))
      .map((m) => m.id);
    if (missingRequests.length || missingMessages.length)
      throw new DomainError("INBOX_REVIEW_INCOMPLETE", "信箱复核尚未覆盖全部待处理项", {
        executed: false,
        missingRequestIds: missingRequests.slice(0, 80),
        missingMessageIds: missingMessages.slice(0, 80),
        nextAction: "回复请求，或将其加入 trackRequestIds；已处理消息加入 handledMessageIds。",
      });
    const token = id("inbox-review");
    const reviewedSeq =
      state.messages.at(-1)?.seq ??
      (
        await tx.query(
          "select coalesce(reviewed_seq,0) as seq from inbox_reviews where conversation_id=$1",
          [conversationId],
        )
      ).rows[0]?.seq ??
      0;
    await tx.query(
      `insert into inbox_reviews(conversation_id,token,fingerprint,reviewed_seq) values($1,$2,$3,$4)
       on conflict(conversation_id) do update set token=excluded.token,fingerprint=excluded.fingerprint,
       reviewed_seq=excluded.reviewed_seq,reviewed_at=now()`,
      [
        conversationId,
        token,
        digest({
          messages: [],
          requests: state.requests.map((q) => [q.id, q.version, Boolean(q.notifiedAt)]),
        }),
        reviewedSeq,
      ],
    );
    return {
      reviewed: true,
      reviewToken: token,
      trackedRequestIds: [...tracked],
      handledMessageIds: [...handled],
    };
  }

  async confirmWait(tx: Tx, conversationId: string, confirmed?: boolean, token?: string) {
    const review = (
      await tx.query("select * from inbox_reviews where conversation_id=$1", [conversationId])
    ).rows[0];
    const state = await this.reviewState(tx, conversationId);
    if (!confirmed || !token || review?.token !== token || review.fingerprint !== state.fingerprint)
      throw new DomainError(
        "INBOX_REVIEW_REQUIRED",
        "等待前必须复核收发信箱；新输入或请求状态变化后需要重新复核",
        {
          executed: false,
          hook: "review_inbox",
          nextAction:
            "先调用 review_inbox，回复或跟踪全部待处理项；取得 reviewToken 后调用 wait_for_message({confirmed:true,reviewToken})。",
        },
      );
    return { waitingForMessage: true, reviewed: true };
  }

  async update(
    tx: Tx,
    conversationId: string,
    requestId: string,
    action: "wait" | "expedite" | "cancel",
    seconds = 120,
    version?: number,
  ) {
    const q = (
      await tx.query(
        "select * from message_requests where id=$1 and sender_conversation_id=$2 for update",
        [requestId, conversationId],
      )
    ).rows[0];
    if (!q) throw new DomainError("FORBIDDEN", "只能跟踪自己发送的请求");
    if (version !== undefined && q.version !== version)
      throw new DomainError("VERSION_CONFLICT", "消息状态已变化，请重新查看信箱");
    if (q.state !== "open") return { requestId, status: q.state, changed: false };
    if (action === "expedite") {
      const target = await agentIdentity(tx, q.recipient_agent_id);
      if (
        target.canvas_id !== q.canvas_id ||
        (q.sender_agent_id &&
          (await collaborationNeedsApproval(tx, q.sender_agent_id, q.recipient_agent_id, false)))
      )
        throw new DomainError(
          "FORBIDDEN",
          "通信范围已变化；重新使用 send_message 发送可审查的消息",
        );
      const latest = (
        await tx.query(
          "select state,cancel_requested_at from runs where subject_id=$1 order by created_at desc,id desc limit 1",
          [q.recipient_conversation_id],
        )
      ).rows[0];
      if (latest?.state === "cancelled" || latest?.cancel_requested_at)
        throw new DomainError("RECIPIENT_STOPPED", "接收者已停止；请由用户恢复运行后再加急");
      const recent = (
        await tx.query(
          "select 1 from messages where conversation_id=$1 and expedite_requested_at>clock_timestamp()-interval '30 seconds' limit 1",
          [q.recipient_conversation_id],
        )
      ).rowCount;
      if (recent) throw new DomainError("EXPEDITE_COOLDOWN", "此接收者刚收到加急，30 秒后可重试");
      const active = (
        await tx.query(
          "select * from runs where subject_id=$1 and state in('queued','running','waiting') and cancel_requested_at is null",
          [q.recipient_conversation_id],
        )
      ).rows[0];
      const messageId = `followup-${q.id}-${q.version}`;
      await this.conversations.append(
        tx,
        q.recipient_conversation_id,
        messageId,
        "message",
        {
          ...(await collaborationIdentity(tx, q.canvas_id, q.sender_agent_id, [
            q.recipient_agent_id,
          ])),
          from: q.sender_agent_id ?? "workspace",
          text:
            "请优先回复原请求：" +
            (await this.requests(tx, conversationId)).find((r) => r.id === q.id)?.message,
          requestId: q.id,
          priority: "expedited",
          replyTo: { to: "request", id: q.id },
          causeId: active?.cause_id,
          language: await this.conversations.language(conversationId, tx),
        },
        active?.id,
      );
      await tx.query(
        "update messages set expedite_requested_at=now(),expedite_run_id=$3 where conversation_id=$1 and client_message_id=$2",
        [q.recipient_conversation_id, messageId, active?.id ?? null],
      );
      if (active?.state === "waiting")
        await this.conversations.runs.enqueue(tx, {
          canvasId: q.canvas_id,
          subjectId: q.recipient_conversation_id,
          kind: "conversation",
          frozen: active.frozen_input,
          causeId: active.cause_id,
        });
    }
    const row = (
      await tx.query(
        "update message_requests set state=$2,deadline_at=clock_timestamp()+$3*interval '1 second',notified_at=null,version=version+1,updated_at=now() where id=$1 returning *",
        [q.id, action === "cancel" ? "cancelled" : "open", seconds],
      )
    ).rows[0];
    await canvasEvent(tx, q.canvas_id, "conversation.changed", { conversationId });
    return {
      requestId: q.id,
      status: row.state,
      action,
      deadlineAt: row.deadline_at,
      version: row.version,
    };
  }

  async status(requestId: string) {
    const q = (
      await this.db.pool.query(
        "select q.sender_conversation_id from message_requests q join canvases c on c.id=q.canvas_id where q.id=$1 and c.deleted_at is null",
        [requestId],
      )
    ).rows[0];
    if (!q) throw new DomainError("NOT_FOUND", "消息请求不存在");
    return (await this.requests(this.db.pool, q.sender_conversation_id)).find(
      (r) => r.id === requestId,
    );
  }

  async updateForOwner(
    requestId: string,
    action: "wait" | "expedite" | "cancel",
    seconds: number,
    version: number,
  ) {
    const q = (
      await this.db.pool.query(
        "select canvas_id,sender_conversation_id from message_requests where id=$1",
        [requestId],
      )
    ).rows[0];
    if (!q) throw new DomainError("NOT_FOUND", "消息请求不存在");
    return this.db.canvas(q.canvas_id, (tx) =>
      this.update(tx, q.sender_conversation_id, requestId, action, seconds, version),
    );
  }

  async tick() {
    const due = (
      await this.db.pool.query(
        "select q.id,q.canvas_id from message_requests q join canvases c on c.id=q.canvas_id where c.deleted_at is null and q.state='open' and q.notified_at is null and q.deadline_at<=clock_timestamp() and not exists(select 1 from runs r where r.subject_id=q.sender_conversation_id and r.reason='tool_contract_upgrade') and not exists(select 1 from tool_calls t join runs r on r.id=t.run_id where r.subject_id=q.sender_conversation_id and t.state='unknown') order by q.deadline_at limit 64",
      )
    ).rows;
    for (const candidate of due)
      await this.db.canvas(candidate.canvas_id, async (tx) => {
        const q = (
          await tx.query(
            "select * from message_requests where id=$1 and state='open' and notified_at is null and deadline_at<=clock_timestamp() for update",
            [candidate.id],
          )
        ).rows[0];
        if (!q) return;
        const barrier = await this.conversations.runs.conversationBarrier(
          q.sender_conversation_id,
          tx,
        );
        if (barrier.paused || barrier.unknown) return;
        const latest = (
          await tx.query(
            "select * from runs where subject_id=$1 order by created_at desc,id desc limit 1",
            [q.sender_conversation_id],
          )
        ).rows[0];
        if (latest?.state === "cancelled" || latest?.cancel_requested_at) return;
        const status = (await this.requests(tx, q.sender_conversation_id)).find(
          (r) => r.id === q.id,
        )!;
        const active = (
          await tx.query(
            "select * from runs where subject_id=$1 and state in('queued','running','waiting') and cancel_requested_at is null",
            [q.sender_conversation_id],
          )
        ).rows[0];
        const language = await this.conversations.language(q.sender_conversation_id, tx);
        const key = `message-deadline-${q.id}-${q.version}`;
        await this.conversations.append(
          tx,
          q.sender_conversation_id,
          key,
          "message_notice",
          {
            ...status,
            event: "response_deadline",
            hook: "update_message",
            actions: ["wait", "expedite", "cancel"],
            requestId: q.id,
            version: q.version,
            text:
              language === "zh-CN"
                ? `预期回复时间已到：${status.recipientName ?? "成员"} ${status.readAt ? "已读，尚未回复" : "尚未读入上下文"}。请用 update_message 选择继续等待、加急或取消跟踪。`
                : `Reply deadline reached: ${status.recipientName ?? "member"} ${status.readAt ? "read the request but has not replied" : "has not read the request"}. Use update_message to wait, expedite or cancel tracking.`,
            language,
            causeId: active?.cause_id ?? latest?.cause_id,
          },
          active?.id,
        );
        await tx.query(
          "update message_requests set notified_at=now(),notice_count=notice_count+1 where id=$1",
          [q.id],
        );
        if (active?.state === "running")
          await tx.query(
            "update messages set expedite_requested_at=now(),expedite_run_id=$3 where conversation_id=$1 and client_message_id=$2",
            [q.sender_conversation_id, key, active.id],
          );
        const resume =
          active?.state === "waiting" ? active : !active && !q.sender_agent_id ? latest : undefined;
        if (resume) {
          try {
            await this.conversations.runs.enqueue(tx, {
              canvasId: q.canvas_id,
              subjectId: q.sender_conversation_id,
              kind: "conversation",
              frozen: resume.frozen_input,
              causeId: resume.cause_id,
            });
          } catch (error) {
            if (
              !(error instanceof DomainError) ||
              !["LIMIT_REACHED", "QUEUE_FULL"].includes(error.code)
            )
              throw error;
          }
        }
        await canvasEvent(tx, q.canvas_id, "conversation.changed", {
          conversationId: q.sender_conversation_id,
        });
      });
  }
}
