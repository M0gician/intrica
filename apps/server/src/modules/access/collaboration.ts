import type { AccessIntent } from "@intrica/contracts";
import { canvasEvent, DomainError, type Sql, type Tx } from "../../adapters/postgres/database.js";
import { collaborationIdentity } from "../execution/messages.js";
import type { Run } from "../execution/store.js";
import type { Conversations } from "../work/conversations.js";
import { completeReply, recordDelivery, replyAddress } from "../work/messaging/deliveries.js";
import { agentIdentity, commonTeamManager, managementChain, teamMemberIds } from "./policy.js";
import { canvasPermissions, coveringGrant } from "./resources.js";

export type Delivery = Extract<AccessIntent, { kind: "collaboration" }>;
export type MessageTarget =
  | { kind: "agent"; agentId: string }
  | { kind: "agents"; agentIds: string[] }
  | { kind: "canvas" }
  | { kind: "team" }
  | { kind: "resource_readers"; resourceIds: string[] };

async function requireBroadcastAuthority(sql: Sql, canvasId: string, senderId: string | null) {
  if (!senderId) return;
  const sender = await agentIdentity(sql, senderId);
  if (sender.canvas_id !== canvasId || sender.config.role !== "admin")
    throw new DomainError("FORBIDDEN", "此广播目标需要当前画布的管理员权限");
}

/** Validate the frozen audience without adding new members during recovery. */
export async function validateDelivery(
  sql: Sql,
  canvasId: string,
  senderId: string | null,
  intent: Delivery,
) {
  if (intent.targetKind === "canvas") await requireBroadcastAuthority(sql, canvasId, senderId);
  if (intent.targetKind === "team" && senderId)
    for (const recipient of intent.recipients)
      if (!(await commonTeamManager(sql, senderId, recipient)))
        throw new DomainError("TARGET_CHANGED", "团队接收范围已变化，消息未发送");
  if (intent.replyTo) {
    const conversation = (
      await sql.query("select id from conversations where agent_id=$1", [senderId])
    ).rows[0];
    if (!conversation) throw new DomainError("FORBIDDEN", "回复必须来自接收该请求的会话");
    const request = await replyAddress(sql, conversation.id, intent.replyTo);
    if (
      request.canvas_id !== canvasId ||
      (request.sender_agent_id
        ? intent.recipients.length !== 1 || intent.recipients[0] !== request.sender_agent_id
        : intent.recipients.length !== 0)
    )
      throw new DomainError("TARGET_CHANGED", "回复地址已变化");
  }
  const targets = await sql.query(
    "select n.id from nodes n join agent_configs a on a.node_id=n.id where n.canvas_id=$1 and n.id=any($2::text[])",
    [canvasId, intent.recipients],
  );
  if (targets.rowCount !== intent.recipients.length)
    throw new DomainError("TARGET_CHANGED", "接收者已删除或不在当前画布，消息未发送");
  if (
    intent.messageKind === "broadcast" &&
    (!intent.targetKind || intent.targetKind === "resource_readers")
  ) {
    const current = await resourceAudience(sql, canvasId, intent.resourceIds ?? [], senderId);
    if (intent.recipients.some((id) => !current.includes(id)))
      throw new DomainError("TARGET_CHANGED", "广播接收者权限已变化，请重新确认接收范围");
  }
}
async function resourceAudience(
  sql: Sql,
  canvasId: string,
  resourceIds: string[],
  senderId: string | null,
) {
  if (!resourceIds.length) throw new DomainError("VALIDATION", "资源读者广播必须指定至少一个资源");
  const resources = (
    await sql.query(
      "select id,kind,body->'resource' as resource from nodes where canvas_id=$1 and id=any($2::text[])",
      [canvasId, resourceIds],
    )
  ).rows;
  if (resources.length !== resourceIds.length || resources.some((r) => r.kind === "agent"))
    throw new DomainError("NOT_FOUND", "广播资源不存在或不是资源节点");
  const permissions = await canvasPermissions(sql, canvasId);
  if (senderId)
    for (const resource of resources)
      if (!(await coveringGrant(permissions.get(senderId) ?? [], resource, "read")))
        throw new DomainError("FORBIDDEN", "广播需要全部指定资源的读取权限");
  const recipients: string[] = [];
  for (const [agentId, grants] of permissions) {
    if (agentId === senderId) continue;
    let covered = true;
    for (const resource of resources)
      if (!(await coveringGrant(grants, resource, "read"))) {
        covered = false;
        break;
      }
    if (covered) recipients.push(agentId);
  }
  return recipients.sort();
}
export async function selectRecipients(
  sql: Sql,
  canvasId: string,
  senderId: string | null,
  target: MessageTarget,
) {
  if (target.kind === "agent") return [target.agentId];
  if (target.kind === "resource_readers")
    return resourceAudience(sql, canvasId, target.resourceIds, senderId);
  if (target.kind === "team")
    return (await visibleTeam(sql, canvasId, senderId))
      .map((a) => a.id)
      .filter((id) => id !== senderId);
  if (target.kind === "canvas") await requireBroadcastAuthority(sql, canvasId, senderId);
  const ids =
    target.kind === "agents"
      ? target.agentIds
      : (
          await sql.query(
            "select n.id from nodes n join agent_configs a on a.node_id=n.id where n.canvas_id=$1 order by n.id",
            [canvasId],
          )
        ).rows.map((row) => row.id as string);
  return [...new Set(ids)].filter((id) => id !== senderId).sort();
}

export async function visibleTeam(sql: Sql, canvasId: string, senderId: string | null) {
  let ids: string[] | null = null;
  if (senderId) {
    const chain = [senderId, ...(await managementChain(sql, senderId))];
    let manager: string | undefined;
    for (const candidate of chain)
      if ((await agentIdentity(sql, candidate)).config.role === "admin") {
        manager = candidate;
        break;
      }
    ids = manager ? [manager, ...(await teamMemberIds(sql, manager))] : [senderId];
  }
  return (
    await sql.query(
      "select n.id,n.body->>'title' as name,a.config->>'role' as role,parent_manager.node_id as \"managerId\" from nodes n join agent_configs a on a.node_id=n.id left join agent_configs parent_manager on parent_manager.node_id=n.parent_id where n.canvas_id=$1 and ($2::text[] is null or n.id=any($2)) order by n.id",
      [canvasId, ids],
    )
  ).rows;
}

/** Frozen recipients are checked as a whole before any history or inbox write. */
export async function deliverCollaboration(
  tx: Tx,
  conversations: Conversations,
  run: Run,
  senderId: string | null,
  intent: Delivery,
  callId: string,
) {
  await validateDelivery(tx, run.canvas_id, senderId, intent);
  const reply = intent.replyTo ? await replyAddress(tx, run.subject_id, intent.replyTo) : undefined;
  if (intent.replyTo) await completeReply(tx, run.subject_id, intent.replyTo, callId);
  const targets = [];
  for (const id of intent.recipients) {
    const c = await conversations.read.forAgent(id, tx);
    if (c.canvas_id !== run.canvas_id) throw new DomainError("FORBIDDEN", "不能跨画布发送");
    targets.push(c);
  }
  const language = await conversations.language(run.subject_id, tx);
  const participants = await collaborationIdentity(tx, run.canvas_id, senderId, intent.recipients);
  await conversations.append(
    tx,
    run.subject_id,
    `send-${callId}`,
    intent.messageKind,
    {
      ...participants,
      text: intent.message,
      recipients: intent.recipients,
      resourceIds: intent.resourceIds,
      fileIds: intent.fileIds,
      expectReply: intent.expectReply ?? false,
      replyWithinSeconds: intent.replyWithinSeconds,
      readWithinSeconds: intent.readWithinSeconds,
      replyTo: intent.replyTo,
    },
    run.id,
  );
  for (const c of targets) {
    const deliveryId = await recordDelivery(
      tx,
      run,
      senderId,
      c,
      { callId, messageId: `send-${callId}`, inboxId: `delivery-${callId}-${c.agent_id}` },
      intent,
    );
    const active = (
      await tx.query(
        "select * from runs where subject_id=$1 and state in('queued','running','waiting') and cancel_requested_at is null",
        [c.id],
      )
    ).rows[0];
    let blocked = false;
    if (active?.state === "waiting" && ["message", "approval"].includes(active.reason)) {
      try {
        await conversations.runs.enqueue(tx, {
          canvasId: run.canvas_id,
          subjectId: c.id,
          kind: "conversation",
          frozen: active.frozen_input,
          causeId: run.cause_id,
        });
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "LIMIT_REACHED") throw error;
        blocked = true;
      }
    }
    await conversations.append(
      tx,
      c.id,
      `delivery-${callId}-${c.agent_id}`,
      "message",
      {
        ...participants,
        text: intent.message,
        from: senderId ?? "workspace",
        messageKind: intent.messageKind,
        resourceIds: intent.resourceIds,
        fileIds: intent.fileIds,
        deliveryId,
        replyTo: { to: "reply", id: deliveryId },
        expectReply: intent.expectReply ?? false,
        replyWithinSeconds: intent.replyWithinSeconds ?? 120,
        readWithinSeconds: intent.readWithinSeconds ?? 60,
        language,
        causeId: run.cause_id,
        ...(blocked ? { activationBlocked: true } : {}),
      },
      active?.id,
    );
  }
  await canvasEvent(tx, run.canvas_id, "conversation.changed", {
    conversationId: run.subject_id,
    agentId: senderId,
    recipients: intent.recipients,
  });
  if (reply && !reply.sender_agent_id) {
    const latest = (
      await tx.query(
        "select * from runs where subject_id=$1 order by created_at desc,id desc limit 1",
        [reply.sender_conversation_id],
      )
    ).rows[0];
    await conversations.append(
      tx,
      reply.sender_conversation_id,
      `reply-${callId}`,
      "message",
      {
        ...participants,
        from: senderId,
        text: intent.message,
        replyTo: intent.replyTo,
        messageKind: intent.messageKind,
        fileIds: intent.fileIds,
        language,
        causeId: run.cause_id,
      },
      latest &&
        ["queued", "running", "waiting"].includes(latest.state) &&
        !latest.cancel_requested_at
        ? latest.id
        : undefined,
    );
    if (latest && latest.state !== "cancelled" && !latest.cancel_requested_at) {
      try {
        await conversations.runs.enqueue(tx, {
          canvasId: run.canvas_id,
          subjectId: reply.sender_conversation_id,
          kind: "conversation",
          frozen: latest.frozen_input,
          causeId: run.cause_id,
        });
      } catch (error) {
        if (
          !(error instanceof DomainError) ||
          !["LIMIT_REACHED", "QUEUE_FULL"].includes(error.code)
        )
          throw error;
      }
    }
    await canvasEvent(tx, run.canvas_id, "conversation.changed", {
      conversationId: reply.sender_conversation_id,
    });
  }
  const deliveries = (
    await tx.query(
      'select id,recipient_agent_id as "recipientId",deadline_at as "deadlineAt" from message_deliveries where origin_call_id=$1 order by id',
      [callId],
    )
  ).rows;
  return {
    delivered: intent.targetKind === "user" ? 1 : intent.recipients.length,
    recipients: intent.recipients,
    deliveries,
  };
}
