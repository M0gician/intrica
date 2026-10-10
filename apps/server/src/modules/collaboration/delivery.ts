import type { MessageAddress } from "@intrica/contracts";
import { canvasEvent, DomainError, type Tx } from "../../adapters/postgres/database.js";
import { collaborationIdentity } from "../execution/messages.js";
import type { Run } from "../execution/store.js";
import type { Conversations } from "../work/conversations.js";
import { createRequest, settleRequest } from "./requests.js";
import type { ResolvedMessage } from "./resolve-target.js";

export async function validateAddresses(tx: Tx, canvasId: string, intent: ResolvedMessage) {
  for (const address of intent.addresses) {
    const row = (
      await tx.query(
        `select c.*,v.deleted_at from conversations c join canvases v on v.id=c.canvas_id where c.id=$1`,
        [address.conversationId],
      )
    ).rows[0];
    if (
      !row ||
      row.canvas_id !== canvasId ||
      row.deleted_at ||
      row.identity_kind === "deleted_agent" ||
      (address.kind === "agent" && row.agent_id !== address.agentId) ||
      (address.kind === "workspace" && row.identity_kind !== "workspace")
    )
      throw new DomainError("TARGET_CHANGED", "原收件会话已失效，消息未发送");
  }
  if (intent.requestId) {
    const request = (
      await tx.query("select state,version from message_requests where id=$1", [intent.requestId])
    ).rows[0];
    if (request?.state !== "open" || Number(request.version) !== intent.requestVersion)
      throw new DomainError("REQUEST_CLOSED", "请求已结束或已被接管");
  }
}

const displayId = (address: MessageAddress) =>
  address.kind === "agent"
    ? address.agentId!
    : address.kind === "user"
      ? "user"
      : `workspace:${address.conversationId}`;

export async function deliverMessage(
  tx: Tx,
  conversations: Conversations,
  run: Run,
  dispatch: any,
  intent: ResolvedMessage,
) {
  const senderId = run.frozen_input.agentId ?? null;
  const sender: MessageAddress = {
    kind: senderId ? "agent" : "workspace",
    conversationId: dispatch.conversation_id,
    ...(senderId ? { agentId: senderId } : {}),
  };
  const language = await conversations.language(dispatch.conversation_id, tx);
  const identity = await collaborationIdentity(tx, run.canvas_id, senderId, intent.recipients);
  const recipients = intent.addresses.map(displayId);
  const content = {
    ...identity,
    messageId: dispatch.id,
    text: intent.message,
    messageKind: intent.messageKind,
    targetKind: intent.targetKind,
    recipients,
    addresses: intent.addresses,
    ...(intent.requestId ? { inReplyTo: intent.requestId } : {}),
    ...(intent.workItemId ? { workItemId: intent.workItemId } : {}),
    fileIds: intent.fileIds,
    resourceIds: intent.resourceIds,
    deliveryState: "sent",
  };
  if (intent.messageKind === "internal") {
    await conversations.append(
      tx,
      dispatch.conversation_id,
      `output-${dispatch.id}`,
      "internal_note",
      {
        text: intent.message,
        messageId: dispatch.id,
        workItemId: intent.workItemId,
        targetKind: "internal",
      },
      run.id,
    );
    await canvasEvent(tx, run.canvas_id, "conversation.changed", {
      conversationId: dispatch.conversation_id,
      agentId: senderId,
    });
    return { messageId: dispatch.id, delivered: 0, internal: true, recipients: [] };
  }
  await validateAddresses(tx, run.canvas_id, intent);
  const human = intent.addresses.length === 1 && intent.addresses[0]!.kind === "user";
  if (!human)
    await conversations.append(
      tx,
      dispatch.conversation_id,
      `send-${dispatch.id}`,
      "message",
      content,
      run.id,
    );
  const deliveries = [];
  const original = intent.requestId
    ? (await tx.query("select * from message_requests where id=$1", [intent.requestId])).rows[0]
    : null;
  for (const address of intent.addresses) {
    const request =
      intent.messageKind === "request"
        ? await createRequest(tx, {
            canvasId: run.canvas_id,
            messageId: dispatch.id,
            sender,
            recipient: address,
            originWorkItemId: intent.workItemId,
            parentRequestId: intent.requestId,
            causeId: intent.causeId,
          })
        : null;
    if (address.kind === "user") {
      await conversations.append(
        tx,
        address.conversationId,
        `delivery-${dispatch.id}`,
        "assistant",
        {
          ...content,
          ...(request ? { collaborationRequestId: request.id } : {}),
        },
        run.id,
      );
      deliveries.push({
        recipient: displayId(address),
        state: "delivered",
        requestId: request?.id,
      });
      continue;
    }
    const workItemId = request?.id ?? original?.origin_work_item_id ?? null;
    const item = workItemId
      ? (await tx.query("select state,work_state from message_requests where id=$1", [workItemId]))
          .rows[0]
      : null;
    const passive = Boolean(
      !request &&
        original &&
        (!workItemId || item?.state !== "open" || item?.work_state === "stopped"),
    );
    const active = (
      await tx.query(
        "select * from runs where subject_id=$1 and state in('queued','running','waiting') and cancel_requested_at is null",
        [address.conversationId],
      )
    ).rows[0];
    let blocked = false;
    if (
      !passive &&
      active?.state === "waiting" &&
      ["message", "approval", "reply_required", "message_protocol"].includes(active.reason)
    ) {
      try {
        await conversations.runs.enqueue(tx, {
          canvasId: run.canvas_id,
          subjectId: address.conversationId,
          kind: "conversation",
          frozen: active.frozen_input,
          causeId: intent.causeId,
        });
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "LIMIT_REACHED") throw error;
        blocked = true;
      }
    }
    if (workItemId && !passive)
      await tx.query(
        "update message_requests set work_state='queued',blocked_reason=null where id=$1 and state='open'",
        [workItemId],
      );
    await conversations.append(
      tx,
      address.conversationId,
      `delivery-${dispatch.id}-${address.conversationId}`,
      "message",
      {
        ...content,
        from: senderId ?? "workspace",
        senderConversationId: sender.conversationId,
        recipients: undefined,
        language,
        causeId: intent.causeId,
        workItemId,
        ...(request ? { collaborationRequestId: request.id } : {}),
        ...(passive ? { passive: true } : {}),
        ...(blocked ? { activationBlocked: true } : {}),
      },
      active?.id,
    );
    deliveries.push({
      recipient: displayId(address),
      state: "delivered",
      requestId: request?.id,
      activationBlocked: blocked,
    });
    await canvasEvent(tx, run.canvas_id, "conversation.changed", {
      conversationId: address.conversationId,
      agentId: address.agentId,
    });
  }
  if (intent.requestId && ["result", "decline"].includes(intent.messageKind))
    await settleRequest(
      tx,
      intent.requestId,
      dispatch.id,
      intent.messageKind as "result" | "decline",
    );
  await canvasEvent(tx, run.canvas_id, "conversation.changed", {
    conversationId: dispatch.conversation_id,
    agentId: senderId,
    recipients,
  });
  return {
    messageId: dispatch.id,
    delivered: intent.addresses.length,
    recipients,
    deliveries,
    ...(intent.requestId ? { requestId: intent.requestId } : {}),
  };
}
