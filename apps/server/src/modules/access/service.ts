import type {
  AccessIntent,
  ApprovalDecision,
  ApprovalPage,
  ApprovalRecord,
  EffectiveAgentPermissions,
} from "@intrica/contracts";
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
import { pendingInboxMessage, projectToolOutcome } from "../execution/messages.js";
import { result, type ToolResult } from "../execution/tool-calls.js";
import type { GraphCommands } from "../graph/commands.js";
import { GraphMutation } from "../graph/mutation.js";
import type { Conversations } from "../work/conversations.js";
import { deliverCollaboration } from "./collaboration.js";
import { publishHandoffReport } from "./handoffs.js";
import {
  canApprove,
  intentBasis,
  intentSummary,
  mayManage,
  operation,
  reviewerFor,
} from "./intents.js";
import {
  escalateApproval,
  finishApproval,
  notifyReviewer,
  reconcileApprovals,
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
import { coveringGrant } from "./resources.js";

export class AccessService {
  private inboxCursor = "";
  constructor(
    readonly db: Database,
    readonly graph: GraphCommands,
    readonly conversations: Conversations,
    readonly assets: AssetStore,
  ) {}

  async describe(agentId: string): Promise<EffectiveAgentPermissions> {
    const identity = await agentIdentity(this.db.pool, agentId);
    const grants = await grantsFor(this.db.pool, agentId);
    const names = new Map(
      (
        await this.db.pool.query(
          "select id,body->>'title' as title from nodes where id=any($1::text[])",
          [grants.slice(0, 200).map((grant) => grant.resource_id)],
        )
      ).rows.map((row) => [row.id, row.title]),
    );
    return {
      role: identity.config.role,
      permissionProtocol: 2,
      commandExecution:
        identity.config.role === "admin" || grants.some((g) => g.execution_mode === "host")
          ? "host"
          : "isolated",
      resources: grants.slice(0, 200).map((grant) => ({
        nodeId: grant.resource_id,
        rootId: grant.root_resource_id,
        title: names.get(grant.resource_id) || grant.resource_id,
        mode: grant.mode,
        execution: grant.execution_mode,
        sourceLinkId: grant.source_link_id,
        delegatedBy: grant.delegated_by ?? null,
      })),
      totalResources: grants.length,
    };
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

  private async apply(
    tx: Tx,
    subject: string,
    intent: AccessIntent,
    callId: string,
    delegatedBy: string | null = null,
  ) {
    const identity = await agentIdentity(tx, subject);
    const mutation = new GraphMutation(tx, identity.canvas_id, OWNER, this.graph.queries);
    const required =
      intent.kind === "role"
        ? intent.role
        : "requiredRole" in intent
          ? intent.requiredRole
          : undefined;
    const roleChanged = required && identity.config.role !== required;
    if (roleChanged)
      await mutation.update(subject, { agent: { ...identity.config, role: required } });
    let output: Record<string, unknown> = { status: "granted" };
    if (intent.kind === "resource") {
      await mutation.connectGrant(
        subject,
        intent.nodeId,
        intent.mode,
        "user_link",
        undefined,
        delegatedBy,
      );
      output = { ...output, nodeId: intent.nodeId, mode: intent.mode };
    }
    if (intent.kind === "path") {
      const workspaceOwner = intent.workspaceOwnerId
        ? await this.graph.queries.node(intent.workspaceOwnerId, tx)
        : null;
      let resource = (
        await tx.query(
          "select n.id from nodes n where n.canvas_id=$1 and n.body->'resource'->>'path'=$2 order by n.created_at,n.id limit 1",
          [identity.canvas_id, intent.path],
        )
      ).rows[0]?.id;
      if (!resource)
        resource = await mutation.insert({
          kind: "text",
          parentId: identity.parent_id ?? identity.canvas_id,
          title: workspaceOwner
            ? `${workspaceOwner.title} · ${intent.directory ? "工作目录" : intent.path.split("/").at(-1)}`
            : intent.path.split("/").at(-1) || intent.path,
          text: intent.path,
          resource: { type: intent.directory ? "directory" : "file", path: intent.path },
          position: { x: 40, y: 40, width: 260, height: 180 },
        });
      // Only admins already possess the host capability that a directory grant
      // currently conveys. Never upgrade a non-admin owner as a side effect of
      // approving its member's path request.
      if (workspaceOwner?.agent?.role === "admin" && workspaceOwner.id !== subject)
        await mutation.connectGrant(
          workspaceOwner.id,
          resource,
          "write",
          "user_link",
          undefined,
          null,
          intent.execution ?? "none",
        );
      const mode =
        intent.mode ??
        (delegatedBy &&
        !(await coveringGrant(
          await grantsFor(tx, delegatedBy),
          { resource: { path: intent.path, type: "directory" } },
          "write",
        ))
          ? "read"
          : "write");
      await mutation.connectGrant(
        subject,
        resource,
        mode,
        "user_link",
        undefined,
        delegatedBy,
        intent.execution ?? "none",
      );
      output = {
        ...output,
        path: intent.path,
        nodeId: resource,
        mode,
        execution: intent.execution ?? "none",
      };
    }
    if (intent.kind === "agent") {
      const args = intent.args;
      if (intent.operation === "hire") {
        const nodeId = await mutation.insert({
          kind: "agent",
          parentId: subject,
          title: args.title,
          agent: { persona: args.persona, role: args.role, enabled: args.enabled },
          position: await mutation.agentPosition(subject),
          origin: "model",
        });
        const runId = (await tx.query("select run_id from tool_calls where id=$1", [callId]))
          .rows[0].run_id;
        await mutation.connectGrant(subject, nodeId, "write", "derived_from", runId);
        await this.grantRecruitResources(
          mutation,
          subject,
          nodeId,
          args,
          identity.config.role === "admin" ? subject : delegatedBy,
        );
        const initialTask = await this.conversations.assignNewAgent(tx, runId, nodeId, args.task);
        output = {
          id: nodeId,
          title: args.title,
          initialTask,
          resourceIds: args.resourceIds ?? [],
          ...(!args.resourceIds?.length
            ? {
                notice:
                  "No shared resources inherited. The member uses its own workspace; host execution may require separate approval.",
              }
            : {}),
        };
      } else if (intent.operation === "dismiss") {
        if (args.agentId === subject) throw new DomainError("FORBIDDEN", "不能移除自己");
        await mutation.deleteNodes([args.agentId]);
        output = { deleted: args.agentId };
      } else {
        const target = await agentIdentity(tx, args.agentId);
        if (target.canvas_id !== identity.canvas_id)
          throw new DomainError("FORBIDDEN", "不能修改其他画布");
        const config = { ...target.config, ...args.patch };
        if (config.schedule === null) delete config.schedule;
        await mutation.update(target.node_id, { agent: config }, args.expectedRevision);
        output = { id: target.node_id, status: "updated" };
      }
    }
    if (intent.kind === "collaboration") {
      const run = (
        await tx.query("select r.* from runs r join tool_calls t on t.run_id=r.id where t.id=$1", [
          callId,
        ])
      ).rows[0];
      for (const nodeId of intent.fileIds ?? []) {
        const node = await this.graph.queries.node(nodeId, tx);
        if (
          node.canvasId !== identity.canvas_id ||
          !node.assetId ||
          node.resource?.snapshot?.assetId !== node.assetId
        )
          throw new DomainError("TARGET_CHANGED", "交付文件的发布版本已变化");
        if (!(await grantsFor(tx, subject)).some((grant) => grant.resource_id === node.id))
          throw new DomainError("FORBIDDEN", "交付文件的读取权限已变化");
        await this.assets.assertAvailable(node.assetId);
      }
      const delivery = await deliverCollaboration(
        tx,
        this.conversations,
        run,
        subject,
        intent,
        callId,
      );
      const informedExecutors =
        intent.messageKind === "report"
          ? await publishHandoffReport(
              mutation,
              run,
              callId,
              intent.message,
              intent.resourceIds ?? [],
            )
          : [];
      return { ...delivery, informedExecutors };
    }
    if (roleChanged || ["resource", "path", "agent"].includes(intent.kind))
      await mutation.finish("access.apply", {
        agentId: subject,
        runId: (await tx.query("select run_id from tool_calls where id=$1", [callId])).rows[0]
          .run_id,
      });
    return output;
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

  async list(
    canvasId: string,
    options: {
      subjectId?: string;
      status?: string;
      cursor?: string;
      limit?: number;
      actor?: Actor;
      requestIds?: string[];
      participantId?: string;
    } = {},
  ): Promise<ApprovalPage> {
    const actor = options.actor ?? OWNER;
    const values = [
      canvasId,
      options.subjectId ?? null,
      options.status ?? null,
      actor.kind === "agent" ? actor.agentId : null,
      options.requestIds ?? null,
      options.participantId ?? null,
    ];
    const filter =
      "canvas_id=$1 and ($2::text is null or subject_id=$2) and ($3::text is null or status=$3) and ($4::text is null or subject_id=$4 or assigned_reviewer_id=$4) and ($5::text[] is null or id=any($5)) and ($6::text is null or subject_id=$6 or assigned_reviewer_id=$6)";
    const total = (
      await this.db.pool.query(`select count(*)::int as n from approvals where ${filter}`, values)
    ).rows[0].n;
    const limit = Math.min(100, options.limit ?? 40);
    const rows = (
      await this.db.pool.query(
        `select a.*,(select state from tool_calls where id=a.origin_call_id) as execution_state from approvals a where ${filter} and ($7::text is null or (created_at,id)<(select created_at,id from approvals where id=$7)) order by created_at desc,id desc limit $8`,
        [...values, options.cursor ?? null, limit + 1],
      )
    ).rows;
    const requests: ApprovalRecord[] = await Promise.all(
      rows.slice(0, limit).map(async (r) => {
        const approvable =
          actor.kind === "owner" ||
          (await canApprove(this.db.pool, actor.agentId, r.subject_id, r.action));
        const summary = intentSummary(r.action, r.basis);
        const ids = [
          r.subject_id,
          r.assigned_reviewer_id,
          ...(summary.recipients ?? []),
          ...(approvable ? (summary.resourceIds ?? []) : []),
        ].filter(Boolean);
        const names = Object.fromEntries(
          (
            await this.db.pool.query(
              "select id,body->>'title' as title from nodes where canvas_id=$1 and id=any($2::text[])",
              [canvasId, ids],
            )
          ).rows.map((n) => [n.id, n.title]),
        );
        return {
          id: r.id,
          agentId: r.subject_id,
          toolCallId: r.origin_call_id,
          status: r.status,
          version: r.version,
          reviewerId: r.assigned_reviewer_id,
          decidedBy: r.decided_by,
          reason: actor.kind === "owner" ? r.reason : "",
          decisionReason: actor.kind === "owner" ? r.decision : null,
          routeReason: r.route_reason,
          kind: r.action.kind,
          scope: ["host", "agent", "collaboration"].includes(r.action.kind) ? "once" : "persistent",
          summary,
          names,
          ...(!approvable && actor.kind === "agent" && r.assigned_reviewer_id === actor.agentId
            ? { blockedReason: "outside_authority" }
            : {}),
          ...(actor.kind === "owner" ||
          r.subject_id === actor.agentId ||
          (r.assigned_reviewer_id === actor.agentId && approvable)
            ? { action: r.action }
            : {}),
          expiresAt: new Date(r.expires_at).toISOString(),
          reviewDueAt: r.review_due_at ? new Date(r.review_due_at).toISOString() : null,
          allowedActions:
            r.status === "pending"
              ? actor.kind === "owner"
                ? ["approve", "deny", ...(r.assigned_reviewer_id ? ["escalate" as const] : [])]
                : r.assigned_reviewer_id === actor.agentId
                  ? [...(approvable ? ["approve" as const] : []), "deny", "escalate"]
                  : []
              : [],
          executionState: r.execution_state,
          createdAt: new Date(r.created_at).toISOString(),
          decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
        };
      }),
    );
    return { requests, total, nextCursor: rows.length > limit ? rows[limit - 1].id : null };
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
          await this.apply(
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
    // The inbox is the durable queue. Rotate the bounded scan even when a model
    // is unavailable, so one broken page cannot starve the next one.
    const eligible = pendingInboxMessage;
    const candidates = (cursor: string) =>
      this.db.pool.query(
        `
      select c.id,c.canvas_id,c.agent_id,cfg.config from conversations c
      join agent_configs cfg on cfg.node_id=c.agent_id join canvases board on board.id=c.canvas_id
      where board.deleted_at is null and c.context->>'modelBlocked' is distinct from 'true'
      and exists(select 1 from messages m where m.conversation_id=c.id and m.seq>c.consumed_message_seq and m.run_id is null and ${eligible})
      and not exists(select 1 from runs r where r.subject_id=c.id and r.state in('queued','running','waiting'))
      order by (c.id<=$1),c.id limit 128`,
        [cursor],
      );
    const inboxes = (await candidates(this.inboxCursor)).rows;
    this.inboxCursor = inboxes.at(-1)?.id ?? "";
    for (const c of inboxes) {
      try {
        const model = await this.conversations.models.capture(c.config.model);
        await this.db.canvas(c.canvas_id, async (tx) => {
          const identity = await agentIdentity(tx, c.agent_id);
          if (digest(identity.config) !== digest(c.config)) return;
          if (
            (
              await tx.query(
                "select 1 from runs where subject_id=$1 and state in('queued','running','waiting')",
                [c.id],
              )
            ).rowCount
          )
            return;
          // Recheck after acquiring the canvas lock: Stop may have consumed the
          // inbox, or another maintainer may already have assigned these messages.
          const groups = (
            await tx.query(
              `select m.content->>'causeId' as cause_id,min(m.seq) as first_seq
            from messages m join conversations c on c.id=m.conversation_id join agent_configs cfg on cfg.node_id=c.agent_id
            where c.id=$1 and m.seq>c.consumed_message_seq and m.run_id is null and ${eligible}
            group by m.content->>'causeId' order by min(m.seq) limit 128`,
              [c.id],
            )
          ).rows;
          for (const group of groups) {
            try {
              await this.conversations.runs.enqueue(tx, {
                ...(group.cause_id ? { causeId: group.cause_id } : {}),
                canvasId: c.canvas_id,
                subjectId: c.id,
                kind: "conversation",
                frozen: {
                  conversationId: c.id,
                  agentId: c.agent_id,
                  selection: [],
                  model,
                  language: await this.conversations.language(c.id, tx),
                },
              });
            } catch (error) {
              if (!(error instanceof DomainError) || error.code !== "LIMIT_REACHED") throw error;
              await tx.query(
                `update messages set content=content||'{"activationBlocked":true}'::jsonb
                where conversation_id=$1 and run_id is null and seq>(select consumed_message_seq from conversations where id=$1)
                and role in ('message','team_notice') and content->>'causeId' is not distinct from $2`,
                [c.id, group.cause_id],
              );
              continue;
            }
            break;
          }
        });
      } catch (error) {
        if (error instanceof DomainError && error.code === "QUEUE_FULL") continue;
        await this.db.canvas(c.canvas_id, async (tx) => {
          if (error instanceof DomainError && error.code === "MODEL_NOT_CONFIGURED") {
            await tx.query(
              "update conversations set context=coalesce(context,'{}')||'{\"modelBlocked\":true}'::jsonb where id=$1",
              [c.id],
            );
            await canvasEvent(tx, c.canvas_id, "conversation.changed", {
              conversationId: c.id,
              agentId: c.agent_id,
            });
          }
          const rows = (
            await tx.query(
              "select * from approvals where assigned_reviewer_id=$1 and status='pending' for update",
              [c.agent_id],
            )
          ).rows;
          for (const r of rows) await escalateApproval(tx, r, "manager_unavailable");
        });
      }
    }
  }
}
