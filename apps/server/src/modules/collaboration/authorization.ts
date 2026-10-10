import { canvasEvent, DomainError, digest, id, type Tx } from "../../adapters/postgres/database.js";
import { canApprove, intentBasis, reviewerFor } from "../access/intents.js";
import { notifyReviewer } from "../access/lifecycle.js";
import { agentIdentity, collaborationNeedsApproval } from "../access/policy.js";
import type { ResolvedMessage } from "./resolve-target.js";

/** A final output and a tool message authorize the same immutable dispatch. */
export async function authorizeDispatch(
  tx: Tx,
  dispatch: any,
  senderId: string | null,
  intent: ResolvedMessage,
) {
  if (!senderId || intent.messageKind === "internal") return null;
  const prior = dispatch.approval_id
    ? (await tx.query("select * from approvals where id=$1", [dispatch.approval_id])).rows[0]
    : null;
  if (prior && !["approved", "pending", "satisfied"].includes(prior.status))
    throw new DomainError("FORBIDDEN", "本次发送的权限申请已结束");
  if (prior?.status === "pending") {
    if (new Date(prior.expires_at).getTime() <= Date.now())
      throw new DomainError("FORBIDDEN", "本次发送的权限申请已过期");
    if (
      !prior.assigned_reviewer_id &&
      ["escalated", "manager_timeout", "manager_unavailable"].includes(prior.route_reason)
    )
      return prior.id as string;
  }
  const current = await agentIdentity(tx, senderId);
  const policyIntent = {
    ...intent,
    reportToManager: intent.recipients.length === 1 && current.manager_id === intent.recipients[0],
  };
  let allowed = true;
  for (const recipient of intent.recipients)
    if (
      recipient !== senderId &&
      (await collaborationNeedsApproval(tx, senderId, recipient, policyIntent.reportToManager))
    )
      allowed = false;
  if (allowed) return null;
  const basis = await intentBasis(tx, senderId, policyIntent);
  if (prior?.status === "approved") {
    const authority =
      prior.decided_by === "owner" ||
      (prior.decided_by && (await canApprove(tx, prior.decided_by, senderId, policyIntent)));
    if (authority && digest(prior.execution_basis) === digest(basis)) return null;
    throw new DomainError("TARGET_CHANGED", "通信授权或目标已变化");
  }
  if (prior?.status === "pending") return prior.id as string;
  if (prior && !["satisfied"].includes(prior.status))
    throw new DomainError("FORBIDDEN", "本次发送的权限申请已结束");
  const reviewer = await reviewerFor(tx, senderId, policyIntent);
  const request = (
    await tx.query(
      `insert into approvals(id,canvas_id,subject_id,origin_call_id,origin_dispatch_id,
    action,basis,complete_tool,status,expires_at,reason,assigned_reviewer_id,review_due_at,route_reason)
    values($1,$2,$3,$4,$5,$6,$7,false,'pending',now()+interval '1 hour',$8,$9,
      case when $9::text is null then null else now()+interval '5 minutes' end,$10) returning *`,
      [
        id("approval"),
        dispatch.canvas_id,
        senderId,
        dispatch.tool_call_id ?? null,
        dispatch.id,
        JSON.stringify(policyIntent),
        JSON.stringify(basis),
        "Agent communication",
        reviewer,
        reviewer ? "manager" : "user",
      ],
    )
  ).rows[0];
  await tx.query(
    "update message_dispatches set state='waiting',approval_id=$2,updated_at=now() where id=$1",
    [dispatch.id, request.id],
  );
  await notifyReviewer(tx, request);
  await canvasEvent(tx, dispatch.canvas_id, "approval.changed", {
    id: request.id,
    agentId: senderId,
    status: "pending",
  });
  return request.id as string;
}
