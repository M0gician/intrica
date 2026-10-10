import type { AddressedMessage, ExternalMessage, MessageAddress } from "@intrica/contracts";
import { DomainError, type Sql } from "../../adapters/postgres/database.js";
import { selectRecipients } from "../access/collaboration.js";
import { agentIdentity } from "../access/policy.js";
import { requestForReply } from "./requests.js";

export type ResolvedMessage = {
  kind: "collaboration";
  dispatchId: string;
  recipients: string[];
  addresses: MessageAddress[];
  message: string;
  messageKind: "request" | "update" | "result" | "decline" | "internal";
  targetKind: AddressedMessage["target"]["kind"];
  requestId?: string | undefined;
  requestVersion?: number | undefined;
  causeId: string;
  workItemId?: string | undefined;
  fileIds?: string[];
  fileVersions?: Record<string, string>;
  resourceIds?: string[];
  handoff?: ExternalMessage["handoff"];
  reportToManager?: boolean;
  priority?: "normal" | "expedite";
  lifetime?: "exclusive" | "independent";
  environmentRefs?: ExternalMessage["environmentRefs"];
  environments?: unknown[];
};

export async function resolveTarget(
  sql: Sql,
  input: {
    canvasId: string;
    conversationId: string;
    agentId: string | null;
    causeId: string;
    dispatchId: string;
    workItemId?: string | undefined;
  },
  payload: AddressedMessage,
): Promise<ResolvedMessage> {
  const base: ResolvedMessage = {
    kind: "collaboration",
    dispatchId: input.dispatchId,
    recipients: [],
    addresses: [],
    message: payload.message,
    messageKind: "internal",
    targetKind: payload.target.kind,
    causeId: input.causeId,
    ...(input.workItemId ? { workItemId: input.workItemId } : {}),
  };
  if (input.workItemId) {
    const work = (
      await sql.query(
        "select cause_id from message_requests where id=$1 and recipient_conversation_id=$2",
        [input.workItemId, input.conversationId],
      )
    ).rows[0];
    base.causeId = work?.cause_id ?? base.causeId;
  }
  if (payload.target.kind === "internal") return base;
  const external = payload as ExternalMessage;
  Object.assign(base, {
    messageKind: external.kind,
    fileIds: external.fileIds,
    handoff: external.handoff,
    priority: external.priority,
    lifetime: external.lifetime,
    environmentRefs: external.environmentRefs,
  });
  if (external.lifetime && external.kind !== "request")
    throw new DomainError("VALIDATION", "lifetime 仅用于新请求");
  if (external.target.kind === "followup" && external.kind !== "update")
    throw new DomainError("VALIDATION", "followup 必须使用 update");
  if (external.handoff && external.kind !== "result")
    throw new DomainError("VALIDATION", "接管交付必须使用 result 消息");
  if (
    external.handoff &&
    (!input.agentId || (await agentIdentity(sql, input.agentId)).config.role !== "admin")
  )
    throw new DomainError("FORBIDDEN", "接管结果交付需要管理员身份");
  if (external.target.kind === "followup") {
    const request = (
      await sql.query("select * from message_requests where id=$1 and canvas_id=$2", [
        external.target.id,
        input.canvasId,
      ])
    ).rows[0];
    const controller = request?.origin_work_item_id
      ? (
          await sql.query("select recipient_conversation_id from message_requests where id=$1", [
            request.origin_work_item_id,
          ])
        ).rows[0]?.recipient_conversation_id
      : request?.sender_conversation_id;
    if (!request || request.sender_kind === "user" || controller !== input.conversationId)
      throw new DomainError("FORBIDDEN", "只能跟进当前会话负责的已发出请求");
    if (request.state !== "open" || request.work_state === "stopped")
      throw new DomainError("REQUEST_CLOSED", "此请求已结束或停止");
    base.requestId = request.id;
    base.requestVersion = Number(request.version);
    base.causeId = request.cause_id ?? input.causeId;
    base.addresses = [
      {
        kind: request.recipient_kind,
        conversationId: request.recipient_conversation_id,
        ...(request.recipient_agent_id ? { agentId: request.recipient_agent_id } : {}),
      },
    ];
    base.recipients = request.recipient_agent_id ? [request.recipient_agent_id] : [];
  } else if (external.target.kind === "request") {
    const request = await requestForReply(
      sql,
      external.target.id,
      input.conversationId,
      input.canvasId,
    );
    if (request.state !== "open")
      throw new DomainError("REQUEST_CLOSED", "此请求已结束", {
        replyMessageId: request.reply_message_id,
      });
    base.requestId = request.id;
    base.workItemId = request.id;
    base.requestVersion = Number(request.version);
    base.causeId = request.cause_id ?? input.causeId;
    base.addresses = [
      {
        kind: request.sender_kind,
        conversationId: request.sender_conversation_id,
        ...(request.sender_agent_id ? { agentId: request.sender_agent_id } : {}),
      },
    ];
    base.recipients = request.sender_kind === "agent" ? [request.sender_agent_id] : [];
    if (request.origin_work_item_id && request.sender_kind !== "user") {
      const controller = (
        await sql.query(
          "select recipient_kind,recipient_conversation_id,recipient_agent_id from message_requests where id=$1",
          [request.origin_work_item_id],
        )
      ).rows[0];
      if (controller) {
        base.addresses = [
          {
            kind: controller.recipient_kind,
            conversationId: controller.recipient_conversation_id,
            ...(controller.recipient_agent_id ? { agentId: controller.recipient_agent_id } : {}),
          },
        ];
        base.recipients = controller.recipient_agent_id ? [controller.recipient_agent_id] : [];
      }
    }
    if (request.sender_kind !== "user") {
      const owners = (
        await sql.query(
          `select distinct p.recipient_kind,p.recipient_conversation_id,p.recipient_agent_id
        from request_dependencies d join message_requests p on p.id=d.parent_id
        where d.child_id=$1 and d.released_at is null and p.state='open' and p.work_state<>'stopped'`,
          [request.id],
        )
      ).rows;
      if (owners.length) {
        base.addresses = owners.map((p) => ({
          kind: p.recipient_kind,
          conversationId: p.recipient_conversation_id,
          ...(p.recipient_agent_id ? { agentId: p.recipient_agent_id } : {}),
        }));
        base.recipients = [...new Set(owners.map((p) => p.recipient_agent_id).filter(Boolean))];
      }
    }
  } else {
    const target =
      external.target.kind === "manager"
        ? {
            kind: "agent" as const,
            agentId: input.agentId ? (await agentIdentity(sql, input.agentId)).manager_id : null,
          }
        : external.target;
    if (target.kind === "agent" && !target.agentId)
      throw new DomainError("NO_MANAGER", "当前没有直属管理者");
    base.recipients = await selectRecipients(sql, input.canvasId, input.agentId, target);
    const rows = (
      await sql.query(
        `select c.id,c.agent_id from conversations c join nodes n on n.id=c.agent_id
      where c.canvas_id=$1 and c.agent_id=any($2::text[])`,
        [input.canvasId, base.recipients],
      )
    ).rows;
    if (rows.length !== base.recipients.length)
      throw new DomainError("TARGET_CHANGED", "接收者不存在或已移出画布");
    base.addresses = rows
      .sort((a, b) => a.agent_id.localeCompare(b.agent_id))
      .map((r) => ({
        kind: "agent",
        conversationId: r.id,
        agentId: r.agent_id,
      }));
    if (external.target.kind === "resource_readers") base.resourceIds = external.target.resourceIds;
  }
  if (input.agentId && base.recipients.length === 1) {
    base.reportToManager =
      (await agentIdentity(sql, input.agentId)).manager_id === base.recipients[0];
  }
  return base;
}
