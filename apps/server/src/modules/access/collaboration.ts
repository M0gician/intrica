import type { AccessIntent } from "@intrica/contracts";
import { canvasEvent, DomainError, type Sql, type Tx } from "../../adapters/postgres/database.js";
import { collaborationIdentity } from "../execution/messages.js";
import type { Run } from "../execution/store.js";
import type { Conversations } from "../work/conversations.js";
import { canvasPermissions, coveringGrant } from "./resources.js";

export type Delivery = Extract<AccessIntent, { kind: "collaboration" }>;
async function resourceAudience(
  sql: Sql,
  canvasId: string,
  resourceIds: string[],
  senderId: string | null,
) {
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
  target: { kind: "agent"; agentId: string } | { kind: "resource_readers"; resourceIds: string[] },
) {
  return target.kind === "agent"
    ? [target.agentId]
    : resourceAudience(sql, canvasId, target.resourceIds, senderId);
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
  if (intent.messageKind === "broadcast") {
    const current = await resourceAudience(tx, run.canvas_id, intent.resourceIds!, senderId);
    if (intent.recipients.some((id) => !current.includes(id)))
      throw new DomainError("TARGET_CHANGED", "广播接收者权限已变化，请重新确认接收范围");
  }
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
    },
    run.id,
  );
  for (const c of targets) {
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
  return { delivered: intent.recipients.length, recipients: intent.recipients };
}
