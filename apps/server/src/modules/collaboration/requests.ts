import type { InputAssociation, MessageAddress } from "@intrica/contracts";
import {
  canvasEvent,
  DomainError,
  id,
  type Sql,
  type Tx,
} from "../../adapters/postgres/database.js";
import { appendMessage } from "../execution/messages.js";
import { releaseDependencies, retainDependency } from "../execution/request-lifecycle.js";

export async function createRequest(
  tx: Tx,
  input: {
    canvasId: string;
    messageId: string;
    sender: MessageAddress;
    recipient: MessageAddress;
    originWorkItemId?: string | null | undefined;
    parentRequestId?: string | null | undefined;
    causeId?: string | null | undefined;
    lifetime?: "exclusive" | "independent" | undefined;
  },
) {
  const created = (
    await tx.query(
      `insert into message_requests(id,canvas_id,message_id,sender_kind,sender_conversation_id,sender_agent_id,
      recipient_conversation_id,recipient_agent_id,origin_work_item_id,parent_request_id,cause_id,recipient_kind,lifetime)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict(message_id,recipient_conversation_id) do update set message_id=excluded.message_id returning *`,
      [
        id("request"),
        input.canvasId,
        input.messageId,
        input.sender.kind,
        input.sender.conversationId,
        input.sender.agentId ?? null,
        input.recipient.conversationId,
        input.recipient.agentId ?? null,
        input.originWorkItemId ?? null,
        input.parentRequestId ?? null,
        input.causeId ?? null,
        input.recipient.kind,
        input.lifetime ?? "exclusive",
      ],
    )
  ).rows[0];
  if (input.originWorkItemId) await retainDependency(tx, input.originWorkItemId, created.id);
  return created;
}

export async function requestForReply(
  sql: Sql,
  requestId: string,
  conversationId: string,
  canvasId: string,
) {
  const request = (
    await sql.query("select * from message_requests where id=$1 and canvas_id=$2", [
      requestId,
      canvasId,
    ])
  ).rows[0];
  if (
    !request ||
    request.recipient_conversation_id !== conversationId ||
    request.recipient_kind === "user"
  )
    throw new DomainError("FORBIDDEN", "只能回复当前会话收到的请求");
  return request;
}

export async function associateUserInput(
  tx: Tx,
  input: {
    canvasId: string;
    conversationId: string;
    agentId?: string | null | undefined;
    messageId: string;
    seq: string;
    association?: InputAssociation | undefined;
  },
) {
  const association = input.association ?? { kind: "new" };
  let request: any;
  if (association.kind === "reply") {
    const question = (
      await tx.query("select * from message_requests where id=$1 and canvas_id=$2", [
        association.requestId,
        input.canvasId,
      ])
    ).rows[0];
    if (
      question?.recipient_kind !== "user" ||
      question.recipient_conversation_id !== input.conversationId ||
      question.state !== "open"
    )
      throw new DomainError("INVALID_STATE", "此追问已结束或不属于当前会话");
    request = (
      await tx.query("select * from message_requests where id=$1 and state='open'", [
        question.origin_work_item_id,
      ])
    ).rows[0];
    if (!request) throw new DomainError("INVALID_STATE", "原任务已结束，请发送新问题");
    await settleRequest(
      tx,
      question.id,
      `user-${input.conversationId}-${input.messageId}`,
      "result",
    );
    await tx.query(
      "update messages set content=content||jsonb_build_object('inReplyTo',$3::text) where conversation_id=$1 and seq=$2",
      [input.conversationId, input.seq, question.id],
    );
    await tx.query(
      "update message_requests set work_state='queued',blocked_reason=null where id=$1",
      [request.id],
    );
  } else if (association.kind === "append") {
    request = await requestForReply(
      tx,
      association.requestId,
      input.conversationId,
      input.canvasId,
    );
    if (request.state !== "open")
      throw new DomainError("INVALID_STATE", "此请求已结束，请发送新问题");
    await tx.query(
      "update message_requests set work_state='queued',blocked_reason=null,updated_at=now() where id=$1",
      [request.id],
    );
  } else
    request = await createRequest(tx, {
      canvasId: input.canvasId,
      messageId: `user-${input.conversationId}-${input.messageId}`,
      sender: { kind: "user", conversationId: input.conversationId },
      recipient: {
        kind: input.agentId ? "agent" : "workspace",
        conversationId: input.conversationId,
        ...(input.agentId ? { agentId: input.agentId } : {}),
      },
    });
  await tx.query(
    `update messages set content=content||jsonb_build_object('workItemId',$3::text,'collaborationRequestId',$3::text)
    where conversation_id=$1 and seq=$2`,
    [input.conversationId, input.seq, request.id],
  );
  let executionSeq = input.seq;
  if (request.recipient_conversation_id !== input.conversationId) {
    const source = (
      await tx.query("select content from messages where conversation_id=$1 and seq=$2", [
        input.conversationId,
        input.seq,
      ])
    ).rows[0];
    executionSeq = await appendMessage(
      tx,
      request.recipient_conversation_id,
      `forward-${input.conversationId}-${input.seq}`,
      "user",
      {
        ...source.content,
        sourceConversationId: input.conversationId,
        sourceMessageSeq: input.seq,
      },
    );
    await tx.query(
      "update messages set content=content||jsonb_build_object('passive',true,'forwardedTo',$3::text,'forwardedSeq',$4::text) where conversation_id=$1 and seq=$2",
      [input.conversationId, input.seq, request.recipient_conversation_id, executionSeq],
    );
  }
  return {
    workItemId: request.id as string,
    conversationId: request.recipient_conversation_id as string,
    agentId: request.recipient_agent_id as string | null,
    seq: executionSeq,
  };
}

export async function closeConversationRequests(tx: Tx, conversationIds: string[], reason: string) {
  const closing = (
    await tx.query(
      "select id from message_requests where state='open' and (recipient_conversation_id=any($1::text[]) or sender_conversation_id=any($1::text[]))",
      [conversationIds],
    )
  ).rows;
  await releaseDependencies(
    tx,
    closing.map((r) => r.id),
    reason,
  );
  await tx.query(
    `update message_requests set state='cancelled',work_state='closed',blocked_reason=$2,version=version+1,updated_at=now()
    where state='open' and (recipient_conversation_id=any($1::text[]) or sender_conversation_id=any($1::text[]))`,
    [conversationIds, reason],
  );
  await tx.query(
    "update message_dispatches set state='cancelled',updated_at=now() where conversation_id=any($1::text[]) and state in('prepared','waiting')",
    [conversationIds],
  );
}

export async function settleRequest(
  tx: Tx,
  requestId: string,
  messageId: string,
  kind: "result" | "decline",
) {
  const row = (
    await tx.query(
      `update message_requests set state=$3,work_state='closed',reply_message_id=$2,
    blocked_reason=null,version=version+1,updated_at=now() where id=$1 and state='open' returning canvas_id,sender_conversation_id`,
      [requestId, messageId, kind === "result" ? "answered" : "declined"],
    )
  ).rows[0];
  if (!row) throw new DomainError("REQUEST_CLOSED", "此请求已有最终回执");
  await releaseDependencies(tx, [requestId], "parent_closed");
  await canvasEvent(tx, row.canvas_id, "conversation.changed", {
    conversationId: row.sender_conversation_id,
    collaborationRequestId: requestId,
  });
}
