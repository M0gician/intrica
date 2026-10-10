import type { AccessIntent, ApprovalDecision } from "@intrica/contracts";
import {
  assertFence,
  canvasEvent,
  type Database,
  DomainError,
  digest,
  id,
  type Sql,
  type Tx,
} from "../../adapters/postgres/database.js";
import type { AssetStore } from "../../adapters/storage/assets.js";
import { projectToolOutcome } from "../execution/messages.js";
import { result, type ToolResult } from "../execution/tool-calls.js";
import type { GraphCommands } from "../graph/commands.js";
import type { GraphMutation } from "../graph/mutation.js";
import type { Conversations } from "../work/conversations.js";
import { applyIntent } from "./apply-intent.js";
import { validateDelivery } from "./collaboration.js";
import { canApprove, intentBasis, mayManage, operation, reviewerFor } from "./intents.js";
import {
  escalateApproval,
  finishApproval,
  notifyReviewer,
  reconcileApprovals,
  wakeDispatch,
  wakeOrigin,
} from "./lifecycle.js";
import {
  type Actor,
  agentIdentity,
  collaborationNeedsApproval,
  grantsFor,
  managementChain,
  OWNER,
} from "./policy.js";
import { describePermissions, listApprovals } from "./reader.js";
import { coveringGrant } from "./resources.js";

export class AccessService {
  constructor(
    readonly db: Database,
    readonly graph: GraphCommands,
    readonly conversations: Conversations,
    readonly assets: AssetStore,
  ) {}

  async describe(agentId: string) {
    return describePermissions(this.db, agentId);
  }

  /** The only request entry; the durable call exists before an operation can ask for permission. */
  async gate(
    tx: Tx,
    actor: Extract<Actor, { kind: "agent" }>,
    callId: string,
    intent: AccessIntent,
    reason: string,
    completeTool = false,
    allowed = false,
  ): Promise<ToolResult | undefined> {
    await assertFence(tx, actor.runId, actor.epoch);
    const call = (
      await tx.query("select * from tool_calls where id=$1 and run_id=$2 for update", [
        callId,
        actor.runId,
      ])
    ).rows[0];
    if (call?.state !== "prepared")
      throw new DomainError("INVALID_STATE", "审批必须绑定尚未执行的工具调用");
    const identity = await agentIdentity(tx, actor.agentId);
    if (intent.kind === "role") allowed = identity.config.role === intent.role;
    if (intent.kind === "agent") allowed = await mayManage(tx, actor.agentId, intent);
    if (intent.kind === "path") allowed ||= identity.config.role === "admin";
    if (intent.kind === "collaboration") {
      await validateDelivery(tx, identity.canvas_id, actor.agentId, intent);
      allowed = true;
      for (const target of intent.recipients)
        if (target !== actor.agentId) {
          const peer = await agentIdentity(tx, target);
          if (peer.canvas_id !== identity.canvas_id)
            throw new DomainError("FORBIDDEN", "不能跨画布发送");
          if (
            await collaborationNeedsApproval(
              tx,
              actor.agentId,
              target,
              intent.messageKind === "report",
            )
          )
            allowed = false;
        }
    }
    if (allowed)
      return completeTool ? result(await this.apply(tx, actor.agentId, intent, callId)) : undefined;
    const basis = await intentBasis(tx, actor.agentId, intent);
    // An approval is a receipt for one frozen call, never an action-hash capability for a later call.
    const prior = call.approval_id
      ? (await tx.query("select * from approvals where id=$1", [call.approval_id])).rows[0]
      : null;
    if (
      prior?.status === "approved" &&
      (await this.decisionAuthority(tx, prior)) &&
      digest(operation(prior.action)) === digest(operation(intent)) &&
      digest(prior.execution_basis) === digest(basis)
    )
      return;
    if (prior?.status === "pending") return result({ status: "pending", requestId: prior.id });
    const reviewer = await reviewerFor(tx, actor.agentId, intent);
    const request = (
      await tx.query(
        `insert into approvals(id,canvas_id,subject_id,origin_call_id,action,basis,complete_tool,status,expires_at,reason,assigned_reviewer_id,review_due_at,route_reason)
      values($1,$2,$3,$4,$5,$6,$7,'pending',now()+interval '1 hour',$8,$9,case when $9::text is null then null else now()+interval '5 minutes' end,$10) returning *`,
        [
          id("approval"),
          identity.canvas_id,
          actor.agentId,
          callId,
          JSON.stringify(intent),
          JSON.stringify(basis),
          completeTool,
          reason,
          reviewer,
          reviewer ? "manager" : "user",
        ],
      )
    ).rows[0];
    await tx.query("update tool_calls set approval_id=$2,state='waiting' where id=$1", [
      callId,
      request.id,
    ]);
    const conversation = await this.conversations.read.forAgent(actor.agentId, tx);
    await this.conversations.append(
      tx,
      conversation.id,
      `approval-${request.id}`,
      "access",
      { requestId: request.id, nodeId: intent.kind === "resource" ? intent.nodeId : actor.agentId },
      actor.runId,
    );
    await notifyReviewer(tx, request);
    await canvasEvent(tx, identity.canvas_id, "approval.changed", {
      id: request.id,
      agentId: actor.agentId,
      status: "pending",
    });
    return result({ status: "pending", requestId: request.id, reviewerId: reviewer });
  }

  async assertPermit(
    actor: Extract<Actor, { kind: "agent" }>,
    logical: string,
    intent: AccessIntent,
  ) {
    await assertFence(this.db.pool, actor.runId, actor.epoch);
    const r = (
      await this.db.pool.query(
        "select a.* from approvals a join tool_calls t on t.id=a.origin_call_id where t.run_id=$1 and t.logical_call_id=$2 and t.approval_id=a.id and t.state='dispatching' and a.status='approved'",
        [actor.runId, logical],
      )
    ).rows[0];
    if (
      !r ||
      !(await this.decisionAuthority(this.db.pool, r)) ||
      digest(operation(r.action)) !== digest(operation(intent)) ||
      digest(r.execution_basis) !== digest(await intentBasis(this.db.pool, actor.agentId, intent))
    )
      throw new DomainError("FORBIDDEN", "当前工具调用没有有效授权");
  }

  private async decisionAuthority(sql: Sql, request: any) {
    if (request.decided_by === "owner") return true;
    try {
      return (
        Boolean(request.decided_by) &&
        (await canApprove(sql, request.decided_by, request.subject_id, request.action))
      );
    } catch (error) {
      if (error instanceof DomainError && error.code === "NOT_FOUND") return false;
      throw error;
    }
  }
  async storedReceiptAllows(call: { approval_id?: string; id: string }) {
    if (!call.approval_id) return false;
    const request = (
      await this.db.pool.query(
        "select * from approvals where id=$1 and origin_call_id=$2 and status='approved'",
        [call.approval_id, call.id],
      )
    ).rows[0];
    return Boolean(request && (await this.decisionAuthority(this.db.pool, request)));
  }

  private apply(
    tx: Tx,
    subject: string,
    intent: AccessIntent,
    callId: string,
    delegatedBy: string | null = null,
  ) {
    return applyIntent(this, tx, subject, intent, callId, delegatedBy);
  }

  async grantRecruitResources(
    mutation: GraphMutation,
    recruiter: string | null,
    member: string,
    args: {
      inheritResources?: boolean;
      resourceIds?: string[];
      resourceModes?: Record<string, "read" | "write">;
    },
    delegatedBy = recruiter,
  ) {
    if (args.inheritResources && args.resourceIds?.length)
      throw new DomainError("VALIDATION", "请选择继承全部资源或指定节点，不能同时设置");
    if (args.inheritResources && !recruiter)
      throw new DomainError("VALIDATION", "工作区招募请指定资源节点");
    const available = recruiter
      ? (await grantsFor(mutation.tx, recruiter)).filter((g) => g.resource_kind !== "agent")
      : [];
    const ids = args.inheritResources
      ? [...new Set(available.map((g) => g.root_resource_id))]
      : [...new Set(args.resourceIds ?? [])];
    for (const id of ids) {
      const target = await mutation.row(id);
      if (target.kind === "agent")
        throw new DomainError("VALIDATION", "只能继承资源节点，不能继承 Agent 的私有空间");
      const grant = recruiter
        ? await coveringGrant(available, { id, resource: target.body.resource }, "read")
        : undefined;
      if (recruiter && !grant) throw new DomainError("FORBIDDEN", "不能委托未获授权的资源");
      const mode = args.resourceModes?.[id] ?? grant?.mode ?? "write";
      if (
        recruiter &&
        !(await coveringGrant(available, { id, resource: target.body.resource }, mode))
      )
        throw new DomainError("FORBIDDEN", "原委托权限已变化，请重新申请");
      await mutation.connectGrant(
        member,
        id,
        mode,
        "user_link",
        undefined,
        delegatedBy,
        grant?.execution_mode ?? "none",
      );
    }
  }

  async list(canvasId: string, options: Parameters<typeof listApprovals>[2] = {}) {
    return listApprovals(this.db, canvasId, options);
  }

  async forSubject(canvasId: string, subjectId: string, focus?: string, historyIds: string[] = []) {
    const page = await this.list(canvasId, { participantId: subjectId });
    const missing = [...new Set([...(focus ? [focus] : []), ...historyIds])].filter(
      (id) => !page.requests.some((r) => r.id === id),
    );
    if (missing.length)
      page.requests.push(
        ...(await this.list(canvasId, { requestIds: missing, limit: 100 })).requests,
      );
    return page.requests;
  }
  async decide(
    requestId: string,
    version: number,
    decision: ApprovalDecision,
    reason: string,
    actor: Actor = OWNER,
    messageToRequester?: string,
  ) {
    const before = (
      await this.db.pool.query("select canvas_id from approvals where id=$1", [requestId])
    ).rows[0];
    if (!before) throw new DomainError("NOT_FOUND", "申请不存在");
    const response = await this.db.canvas(before.canvas_id, async (tx) => {
      if (actor.kind === "agent") await assertFence(tx, actor.runId, actor.epoch);
      await reconcileApprovals(tx, before.canvas_id);
      const r = (await tx.query("select * from approvals where id=$1 for update", [requestId]))
        .rows[0];
      if (r.version !== version || r.status !== "pending")
        return { conflict: true, status: r.status };
      if (
        actor.kind === "agent" &&
        (r.assigned_reviewer_id !== actor.agentId ||
          !(await managementChain(tx, r.subject_id)).includes(actor.agentId))
      )
        throw new DomainError("FORBIDDEN", "只有当前指定且仍在管理链内的管理者可审查此申请");
      if (decision === "escalate") {
        await escalateApproval(tx, r, "escalated", actor.kind === "owner");
      } else if (decision === "deny") {
        await finishApproval(tx, r, "denied", {
          ...result({
            status: "denied",
            requestId: r.id,
            nextAction:
              "Do not repeat this request. Continue within existing permissions or ask your manager for a different plan.",
            ...(messageToRequester ? { message: messageToRequester } : {}),
          }),
          isError: true,
        });
        await tx.query("update approvals set decision=$2,decided_by=$3 where id=$1", [
          requestId,
          reason,
          actor.kind === "owner" ? "owner" : actor.agentId,
        ]);
      } else {
        if (
          actor.kind === "agent" &&
          !(await canApprove(tx, actor.agentId, r.subject_id, r.action))
        )
          throw new DomainError("FORBIDDEN", "此申请超出你的授权范围，请继续向上一级转交");
        // Store the decision first, within this transaction, to exclude it from graph reconciliation.
        await tx.query(
          "update approvals set status='approved',version=version+1,decision=$2,decided_by=$3,decided_at=now() where id=$1",
          [requestId, reason, actor.kind === "owner" ? "owner" : actor.agentId],
        );
        const output = result(
          r.origin_dispatch_id
            ? { status: "approved", messageId: r.origin_dispatch_id }
            : await this.apply(
                tx,
                r.subject_id,
                r.action,
                r.origin_call_id,
                actor.kind === "agent" ? actor.agentId : null,
              ),
        );
        const basis = await intentBasis(
          tx,
          r.subject_id,
          operation(r.action) as AccessIntent,
        ).catch(() => null);
        await tx.query("update approvals set execution_basis=$2,result=$3 where id=$1", [
          requestId,
          JSON.stringify(basis),
          JSON.stringify(output),
        ]);
        await tx.query(
          "update tool_calls set state=$2,result=$3,delivered_at=null,updated_at=now() where id=$1 and state='waiting'",
          [
            r.origin_call_id,
            r.complete_tool ? "succeeded" : "prepared",
            r.complete_tool ? JSON.stringify(output) : null,
          ],
        );
        await wakeOrigin(tx, r.origin_call_id);
        if (r.origin_dispatch_id) await wakeDispatch(tx, r.origin_dispatch_id);
        await projectToolOutcome(tx, r.origin_call_id);
      }
      await canvasEvent(tx, before.canvas_id, "approval.changed", {
        id: requestId,
        agentId: r.subject_id,
        status:
          decision === "escalate" ? "pending" : decision === "approve" ? "approved" : "denied",
      });
      return {
        status:
          decision === "escalate" ? "pending" : decision === "approve" ? "approved" : "denied",
      };
    });
    if ("conflict" in response)
      throw new DomainError("VERSION_CONFLICT", `申请已变化（${response.status}），请重新载入`);
    return response;
  }

  async maintain() {
    const canvases = (
      await this.db.pool.query(
        "select distinct a.canvas_id from approvals a join canvases c on c.id=a.canvas_id where a.status='pending' and c.deleted_at is null",
      )
    ).rows;
    for (const c of canvases)
      await this.db.canvas(c.canvas_id, (tx) => reconcileApprovals(tx, c.canvas_id));
  }
}
