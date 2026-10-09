import type { GraphDelta, Node } from "@intrica/contracts";
import { nextPortraitVariant, portraitVariant, schemas } from "@intrica/contracts";
import { CronExpressionParser } from "cron-parser";
import { Value } from "typebox/value";
import { canonicalPath } from "../../adapters/host/sandbox.js";
import { canvasEvent, DomainError, id, type Tx } from "../../adapters/postgres/database.js";
import { roleRank } from "../access/intents.js";
import { reconcileApprovals } from "../access/lifecycle.js";
import type { Actor } from "../access/policy.js";
import { authorize, canReadAgentResources, grantsFor, managementChain } from "../access/policy.js";
import {
  canvasPermissions,
  coveringGrant,
  type ResourceGrant,
  reducedPermissions,
} from "../access/resources.js";
import { cancelAgents } from "../execution/cancellation.js";
import { agentPosition } from "./placement.js";
import {
  edgeView,
  type GraphQueries,
  type NodeRow,
  nodeColumns,
  nodeJoin,
  nodeView,
} from "./queries.js";

export type Change = { id: string; before: any; after: any };
export type UndoPatch = { nodes: Change[]; edges: Change[]; grants: Change[] };
/** The only mutable graph boundary. Callers must already hold the canvas row. */
export class GraphMutation {
  private beforeNodes = new Map<string, NodeRow | null>();
  private beforeEdges = new Map<string, any>();
  private affectedScopes = new Set<string>();
  private beforeGrants = new Map<string, any>();
  private accessBefore?: Map<string, ResourceGrant[]>;
  async capturePermissions() {
    this.accessBefore ??= await canvasPermissions(this.tx, this.canvasId);
  }
  async reconcilePermissions() {
    const after = await canvasPermissions(this.tx, this.canvasId);
    const delegated = (
      await this.tx.query("select * from grants where canvas_id=$1 and delegated_by is not null", [
        this.canvasId,
      ])
    ).rows;
    for (const g of delegated) {
      if ((after.get(g.subject_id) ?? []).some((n) => n.id === g.id)) continue;
      if (!this.beforeGrants.has(g.id)) this.beforeGrants.set(g.id, g);
      await this.tx.query("delete from grants where id=$1", [g.id]);
      if (
        !(await this.tx.query("select 1 from grants where source_link_id=$1", [g.source_link_id]))
          .rowCount
      )
        await this.removeEdge(g.source_link_id);
    }
    const reduced = this.accessBefore ? reducedPermissions(this.accessBefore, after) : [];
    if (reduced.length) await cancelAgents(this.tx, reduced);
    return after;
  }
  constructor(
    readonly tx: Tx,
    readonly canvasId: string,
    readonly actor: Actor,
    readonly queries: GraphQueries,
  ) {}
  async row(nodeId: string): Promise<NodeRow> {
    const row = (
      await this.tx.query(
        `select ${nodeColumns},
      (select id from conversations where agent_id=n.id) as conversation_id from ${nodeJoin} where n.id=$1 and n.canvas_id=$2`,
        [nodeId, this.canvasId],
      )
    ).rows[0];
    if (!row) throw new DomainError("NOT_FOUND", "元素不存在");
    return row;
  }
  private async remember(nodeId: string) {
    if (!this.beforeNodes.has(nodeId)) this.beforeNodes.set(nodeId, await this.row(nodeId));
  }
  async parent(parentId: string): Promise<string | null> {
    if (parentId === this.canvasId) return null;
    await this.row(parentId);
    return parentId;
  }
  async agentPosition(parentId: string, size?: { width: number; height: number }) {
    const parent = await this.parent(parentId);
    return agentPosition(
      (
        await this.tx.query(
          "select x,y,w as width,h as height from nodes where canvas_id=$1 and parent_id is not distinct from $2",
          [this.canvasId, parent],
        )
      ).rows,
      size,
    );
  }
  async insert(input: {
    kind: Node["kind"];
    parentId: string;
    title?: string;
    text?: string;
    summary?: string;
    position: Node["position"];
    agent?: Node["agent"];
    todo?: Node["todo"];
    resource?: Node["resource"];
    assetId?: string;
    alt?: string;
    origin?: "user" | "model";
    id?: string;
    shareWithManagers?: boolean;
    /** Only the tool's validated publication of a file in its own workspace sets this. */
    publishFile?: boolean;
  }) {
    await authorize(this.tx, this.actor, this.canvasId, null, "write");
    if (input.kind === "agent" && this.actor.kind !== "owner")
      throw new DomainError("FORBIDDEN", "创建 Agent 需要用户批准");
    const parentId = await this.parent(input.parentId);
    if (input.kind === "pdf" && !input.assetId && input.resource?.type !== "file")
      throw new DomainError("VALIDATION", "PDF 节点需要 PDF 附件或服务器文件");
    if (input.assetId) {
      if (!["image", "pdf"].includes(input.kind) && input.resource?.type !== "file")
        throw new DomainError("VALIDATION", "文件附件需要文件资源");
      const asset = (
        await this.tx.query("select mime from assets where id=$1 and state='ready'", [
          input.assetId,
        ])
      ).rows[0];
      if (
        !asset ||
        (input.kind === "pdf" && asset.mime !== "application/pdf") ||
        (input.kind === "image" && !asset?.mime.startsWith("image/"))
      )
        throw new DomainError("VALIDATION", "节点类型与附件类型不匹配");
    }
    const nodeId = input.id ?? id("n");
    const order = (
      await this.tx.query(
        "select coalesce(max(sort_key),0)+1024 as next from nodes where canvas_id=$1 and parent_id is not distinct from $2",
        [this.canvasId, parentId],
      )
    ).rows[0].next;
    const canonicalResource = input.resource
      ? { ...input.resource, path: await canonicalPath(input.resource.path) }
      : undefined;
    const body = Object.fromEntries(
      Object.entries({
        title: input.title ?? "",
        text: input.text ?? "",
        summary: input.summary,
        resource: canonicalResource,
        alt: input.alt,
        todo: input.kind === "todo" ? (input.todo ?? { completed: false }) : undefined,
      }).filter(([, v]) => v !== undefined),
    );
    const p = input.position;
    if (input.publishFile && canonicalResource?.path !== input.resource?.path)
      throw new DomainError("TARGET_CHANGED", "发布文件的实际路径已变化，请重新核查");
    if (!Value.Check(schemas.RectSchema, p) || !Number.isFinite(p.x) || !Number.isFinite(p.y))
      throw new DomainError("VALIDATION", "元素位置无效");
    if (input.agent && !Value.Check(schemas.AgentConfigSchema, input.agent))
      throw new DomainError("VALIDATION", "Agent 配置无效");
    if (input.resource && !Value.Check(schemas.LocalResourceSchema, input.resource))
      throw new DomainError("VALIDATION", "资源路径无效");
    if (input.resource?.snapshot && input.resource.snapshot.assetId !== input.assetId)
      throw new DomainError("VALIDATION", "文件版本与附件不一致");
    await this.tx.query(
      "insert into nodes(id,canvas_id,parent_id,sort_key,kind,body,x,y,w,h,origin,asset_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [
        nodeId,
        this.canvasId,
        parentId,
        order,
        input.kind,
        JSON.stringify(body),
        p.x,
        p.y,
        Math.max(1, p.width),
        Math.max(1, p.height),
        input.origin ?? (this.actor.kind === "agent" ? "model" : "user"),
        input.assetId ?? null,
      ],
    );
    this.beforeNodes.set(nodeId, null);
    this.affectedScopes.add(input.parentId);
    if (input.kind === "agent") {
      const supplied = input.agent ?? { persona: "", role: "read", enabled: false };
      const existing = (
        await this.tx.query(
          "select a.node_id,a.config from agent_configs a join nodes n on n.id=a.node_id where n.canvas_id=$1",
          [this.canvasId],
        )
      ).rows;
      const config = {
        ...supplied,
        portraitVariant:
          supplied.portraitVariant ??
          nextPortraitVariant(
            existing.map((a) => portraitVariant(a.node_id, a.config.portraitVariant)),
          ),
      };
      await this.tx.query("insert into agent_configs(node_id,config,enabled) values($1,$2,$3)", [
        nodeId,
        JSON.stringify(config),
        config.enabled,
      ]);
      await this.syncSchedule(nodeId, config);
      await this.tx.query("insert into conversations(id,canvas_id,agent_id) values($1,$2,$3)", [
        id("conversation"),
        this.canvasId,
        nodeId,
      ]);
    }
    if (this.actor.kind === "agent") {
      // Capture qualified recipients before granting the new output to its author.
      // These are delivered team assets, not access to the employee's private space.
      const recipients: string[] = [];
      for (const manager of await managementChain(this.tx, this.actor.agentId)) {
        if (input.shareWithManagers === false) continue;
        if (!(await canReadAgentResources(this.tx, manager, this.actor.agentId))) continue;
        if (
          input.resource &&
          !input.publishFile &&
          !(await coveringGrant(
            await grantsFor(this.tx, manager),
            { resource: input.resource },
            "read",
          ))
        )
          continue;
        recipients.push(manager);
      }
      await this.connectGrant(this.actor.agentId, nodeId, "write", "derived_from");
      for (const manager of recipients) {
        const edge = await this.createEdge(manager, nodeId, "user_link");
        let mode: "read" | "write" =
          (await this.row(manager)).agent?.role === "read" ? "read" : "write";
        // A fresh report can be maintained by its manager, but linking an
        // existing file must never upgrade that manager's path authority.
        if (
          input.resource &&
          !(await coveringGrant(
            await grantsFor(this.tx, manager),
            { resource: input.resource },
            "write",
          ))
        )
          mode = "read";
        await this.grant(manager, nodeId, mode, edge.id);
      }
    }
    return nodeId;
  }
  async update(nodeId: string, patch: Record<string, any>, expectedVersion?: number) {
    if (patch.agent) await this.capturePermissions();
    await authorize(this.tx, this.actor, this.canvasId, nodeId, patch.agent ? "manage" : "write");
    const row = await this.row(nodeId);
    if (expectedVersion !== undefined && row.content_version !== expectedVersion)
      throw new DomainError("VERSION_CONFLICT", "内容已被修改，请重新载入");
    await this.remember(nodeId);
    const body = { ...row.body };
    for (const key of ["title", "text", "alt", "summary", "todo"])
      if (patch[key] !== undefined) body[key] = patch[key];
    if (patch.todo && row.kind !== "todo")
      throw new DomainError("VALIDATION", "只有待办元素可设置完成状态");
    await this.tx.query("update nodes set body=$2,content_version=content_version+1 where id=$1", [
      nodeId,
      JSON.stringify(body),
    ]);
    if (patch.agent) {
      if (!Value.Check(schemas.AgentConfigSchema, patch.agent))
        throw new DomainError("VALIDATION", "Agent 配置无效");
      if (row.kind !== "agent") throw new DomainError("VALIDATION", "此元素不是 Agent");
      await this.tx.query("update agent_configs set config=$2,enabled=$3 where node_id=$1", [
        nodeId,
        JSON.stringify(patch.agent),
        patch.agent.enabled,
      ]);
      await this.syncSchedule(nodeId, patch.agent);
      if (JSON.stringify(row.agent?.model) !== JSON.stringify(patch.agent.model)) {
        await this.tx.query(
          "update conversations set context=context-'modelBlocked' where agent_id=$1",
          [nodeId],
        );
        await this.tx.query(
          "update schedules set enabled=true,spec=spec-'blockedReason',next_due_at=now() where agent_id=$1 and spec->>'blockedReason'='model_not_configured'",
          [nodeId],
        );
      }
      if (roleRank[patch.agent.role as keyof typeof roleRank] < roleRank[row.agent!.role])
        await cancelAgents(this.tx, [nodeId]);
    }
  }
  async syncSchedule(nodeId: string, config: NonNullable<Node["agent"]>) {
    const schedule = config.schedule;
    if (!config.enabled) {
      await this.tx.query(
        "update schedules set enabled=false where agent_id=$1 and kind='resource_change'",
        [nodeId],
      );
    }
    if (!schedule?.enabled) {
      await this.tx.query("update schedules set enabled=false where agent_id=$1 and kind='cron'", [
        nodeId,
      ]);
      return;
    }
    let next: Date;
    try {
      next = CronExpressionParser.parse(schedule.cron, { tz: schedule.timezone ?? "UTC" })
        .next()
        .toDate();
    } catch {
      throw new DomainError("VALIDATION", "定时计划或时区无效");
    }
    await this.tx.query(
      "insert into schedules(id,canvas_id,agent_id,kind,next_due_at,timezone,spec,dedupe_key,enabled) values($1,$2,$3,'cron',$4,$5,$6,$1,true) on conflict(dedupe_key) do update set next_due_at=excluded.next_due_at,timezone=excluded.timezone,spec=excluded.spec,enabled=true where not schedules.enabled or schedules.spec is distinct from excluded.spec",
      [
        `cron-${nodeId}`,
        this.canvasId,
        nodeId,
        next,
        schedule.timezone ?? "UTC",
        JSON.stringify(schedule),
      ],
    );
  }
  async move(
    nodeId: string,
    parentId: string,
    x: number,
    y: number,
    index?: number,
    expectedLayoutVersion?: number,
  ) {
    await authorize(this.tx, this.actor, this.canvasId, nodeId, "write");
    const row = await this.row(nodeId);
    if (expectedLayoutVersion !== undefined && row.layout_version !== expectedLayoutVersion)
      throw new DomainError("VERSION_CONFLICT", "位置已被修改");
    const parent = await this.parent(parentId);
    if (parent !== row.parent_id) await this.capturePermissions();
    const cycle = await this.tx.query(
      "with recursive tree as (select id from nodes where id=$1 union all select n.id from nodes n join tree t on n.parent_id=t.id) select id from tree where id=$2",
      [nodeId, parent],
    );
    if (cycle.rowCount)
      throw new DomainError("INVALID_DROP_TARGET", "不能把元素移动到自身或后代内部");
    await this.remember(nodeId);
    this.affectedScopes.add(row.parent_id ?? row.canvas_id);
    this.affectedScopes.add(parentId);
    let sortKey = row.sort_key;
    if (parent !== row.parent_id || index !== undefined) {
      const siblings = (
        await this.tx.query(
          "select id,sort_key from nodes where canvas_id=$1 and parent_id is not distinct from $2 and id<>$3 order by sort_key,id",
          [this.canvasId, parent, nodeId],
        )
      ).rows;
      const insertion = Math.max(0, Math.min(index ?? siblings.length, siblings.length));
      let left = insertion ? BigInt(siblings[insertion - 1].sort_key) : 0n;
      let right = insertion < siblings.length ? BigInt(siblings[insertion].sort_key) : left + 2048n;
      if (right - left <= 1n) {
        for (const [i, sibling] of siblings.entries()) {
          await this.remember(sibling.id);
          await this.tx.query(
            "update nodes set sort_key=$2,layout_version=layout_version+1 where id=$1",
            [sibling.id, (i + 1) * 1024],
          );
        }
        left = BigInt(insertion * 1024);
        right = left + 1024n;
      }
      sortKey = String((left + right) / 2n);
    }
    await this.tx.query(
      "update nodes set parent_id=$2,x=$3,y=$4,sort_key=$5,layout_version=layout_version+1 where id=$1",
      [nodeId, parent, x, y, sortKey],
    );
  }

  async link(
    from: string,
    to: string,
    kind = "user_link",
    attemptId?: string,
    sourceRevision?: number,
    grant = false,
  ) {
    await this.capturePermissions();
    if (from === to) throw new DomainError("SELF_LINK", "不能连接自身");
    await this.row(from);
    await this.row(to);
    if (this.actor.kind !== "owner") {
      if (this.beforeNodes.get(from) !== null)
        await authorize(this.tx, this.actor, this.canvasId, from, "read");
      if (this.beforeNodes.get(to) !== null)
        await authorize(this.tx, this.actor, this.canvasId, to, "read");
    }
    const edge = await this.createEdge(from, to, kind, attemptId, sourceRevision);
    // This is the explicit owner 'connect resource' command, not arbitrary graph linking.
    if (grant && this.actor.kind === "owner") {
      for (const [agent, resource] of [
        [from, to],
        [to, from],
      ]) {
        const config = await this.tx.query("select node_id from agent_configs where node_id=$1", [
          agent,
        ]);
        if (config.rowCount) await this.grant(agent!, resource!, "write", edge.id);
      }
    }
    return edge;
  }
  private async createEdge(
    from: string,
    to: string,
    kind: string,
    attemptId?: string,
    sourceRevision?: number,
  ) {
    const edgeId = id("edge");
    const result = await this.tx.query(
      "insert into edges(id,canvas_id,from_id,to_id,kind,source_attempt_id,source_revision) values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing returning *",
      [edgeId, this.canvasId, from, to, kind, attemptId ?? null, sourceRevision ?? null],
    );
    const edge =
      result.rows[0] ??
      (
        await this.tx.query(
          "select * from edges where canvas_id=$1 and kind=$2 and least(from_id,to_id)=least($3::text,$4::text) and greatest(from_id,to_id)=greatest($3::text,$4::text)",
          [this.canvasId, kind, from, to],
        )
      ).rows[0];
    if (result.rows[0]) this.beforeEdges.set(edgeId, null);
    return edgeView(edge);
  }
  private async grant(
    subject: string,
    resource: string,
    mode: "read" | "write",
    edgeId: string,
    delegatedBy: string | null = null,
    execution: import("@intrica/contracts").CommandPermission = "none",
  ) {
    const before = (
      await this.tx.query(
        "select * from grants where subject_id=$1 and resource_id=$2 and delegated_by is not distinct from $3",
        [subject, resource, delegatedBy],
      )
    ).rows[0];
    const grantId = before?.id ?? id("grant");
    if (!this.beforeGrants.has(grantId)) this.beforeGrants.set(grantId, before ?? null);
    await this.tx.query(
      `insert into grants(id,canvas_id,subject_id,resource_id,mode,source_link_id,delegated_by,execution_mode) values($1,$2,$3,$4,$5,$6,$7,$8)
      on conflict(subject_id,resource_id,delegated_by) do update set mode=excluded.mode,execution_mode=excluded.execution_mode,source_link_id=excluded.source_link_id,version=grants.version+1`,
      [grantId, this.canvasId, subject, resource, mode, edgeId, delegatedBy, execution],
    );
  }
  async connectGrant(
    subject: string,
    resource: string,
    mode: "read" | "write",
    kind = "user_link",
    sourceRunId?: string,
    delegatedBy: string | null = null,
    execution: import("@intrica/contracts").CommandPermission = "none",
  ) {
    // Agent callers can grant only an artifact created in this mutation to themselves.
    if (
      this.actor.kind === "agent" &&
      (subject !== this.actor.agentId || this.beforeNodes.get(resource) !== null)
    )
      throw new DomainError("FORBIDDEN", "不能自行扩展授权");
    const sourceRun = this.actor.kind === "agent" ? this.actor.runId : sourceRunId;
    const source =
      kind === "derived_from" && sourceRun
        ? (
            await this.tx.query(
              "select id from attempts where run_id=$1 order by epoch desc limit 1",
              [sourceRun],
            )
          ).rows[0]?.id
        : undefined;
    const edge = await this.link(
      kind === "derived_from" ? resource : subject,
      kind === "derived_from" ? subject : resource,
      kind,
      source,
      kind === "derived_from" ? (await this.row(subject)).content_version : undefined,
    );
    await this.capturePermissions();
    await this.grant(subject, resource, mode, edge.id, delegatedBy, execution);
  }
  async deleteEdge(edgeId: string, expectedVersion?: number) {
    if (this.actor.kind !== "owner") throw new DomainError("FORBIDDEN", "删除连接需要用户操作");
    return this.removeEdge(edgeId, expectedVersion);
  }
  private async removeEdge(edgeId: string, expectedVersion?: number) {
    await this.capturePermissions();
    const row = (
      await this.tx.query("select * from edges where id=$1 and canvas_id=$2", [
        edgeId,
        this.canvasId,
      ])
    ).rows[0];
    if (!row) throw new DomainError("NOT_FOUND", "连接不存在");
    if (expectedVersion !== undefined && row.version !== expectedVersion)
      throw new DomainError("VERSION_CONFLICT", "连接已变化");
    this.beforeEdges.set(edgeId, row);
    const grants = (await this.tx.query("select * from grants where source_link_id=$1", [edgeId]))
      .rows;
    for (const g of grants) if (!this.beforeGrants.has(g.id)) this.beforeGrants.set(g.id, g);
    await this.tx.query("delete from edges where id=$1", [edgeId]);
  }
  async deleteNodes(nodeIds: string[]) {
    await this.capturePermissions();
    const rows = (
      await this.tx.query(
        `with recursive tree as (
      select id from nodes where canvas_id=$1 and id=any($2::text[]) union select n.id from nodes n join tree t on n.parent_id=t.id
    ) select ${nodeColumns},(select id from conversations where agent_id=n.id) as conversation_id from ${nodeJoin} join tree t on t.id=n.id`,
        [this.canvasId, nodeIds],
      )
    ).rows;
    if (!rows.length) throw new DomainError("NOT_FOUND", "元素不存在");
    for (const row of rows) {
      await authorize(this.tx, this.actor, this.canvasId, row.id, "write");
      this.beforeNodes.set(row.id, row);
      this.affectedScopes.add(row.parent_id ?? this.canvasId);
    }
    const ids = rows.map((r) => r.id);
    const removed = (
      await this.tx.query(
        "delete from grants where resource_id=any($1::text[]) or subject_id=any($1::text[]) returning *",
        [ids],
      )
    ).rows;
    for (const g of removed) if (!this.beforeGrants.has(g.id)) this.beforeGrants.set(g.id, g);
    await cancelAgents(this.tx, [...ids, ...removed.map((g) => g.subject_id)]);
    const edges = (
      await this.tx.query(
        "select id from edges where from_id=any($1::text[]) or to_id=any($1::text[])",
        [ids],
      )
    ).rows;
    // Deleting an authorized node also removes its incident relationships.
    for (const edge of edges) await this.removeEdge(edge.id);
    await this.tx.query(
      "update runs set cancel_requested_at=now() where subject_id in (select id from conversations where agent_id=any($1::text[])) and state in ('running','queued','waiting')",
      [ids],
    );
    await this.tx.query("delete from nodes where id=any($1::text[])", [ids]);
  }
  async finish(
    kind: string,
    // Trigger provenance only; this never changes mutation authority.
    source: { agentId: string; runId: string } | null = this.actor.kind === "agent"
      ? this.actor
      : null,
    command: GraphDelta["command"] = null,
    modelOperationId: string | null = null,
  ) {
    const effective = await this.reconcilePermissions();
    await reconcileApprovals(this.tx, this.canvasId);
    const grants: Change[] = [];
    for (const [id, before] of this.beforeGrants)
      grants.push({
        id,
        before,
        after: (await this.tx.query("select * from grants where id=$1", [id])).rows[0] ?? null,
      });
    const nodes: Change[] = [];
    const edges: Change[] = [];
    for (const [nodeId, before] of this.beforeNodes) {
      const after =
        (await this.tx.query(`select ${nodeColumns} from ${nodeJoin} where n.id=$1`, [nodeId]))
          .rows[0] ?? null;
      nodes.push({ id: nodeId, before, after });
    }
    for (const [edgeId, before] of this.beforeEdges)
      edges.push({
        id: edgeId,
        before,
        after: (await this.tx.query("select * from edges where id=$1", [edgeId])).rows[0] ?? null,
      });
    const updated = (
      await this.tx.query(
        "update canvases set graph_revision=graph_revision+1 where id=$1 returning graph_revision, current_timestamp as committed_at",
        [this.canvasId],
      )
    ).rows[0];
    const upserts = nodes.filter((n) => n.after).map((n) => nodeView(n.after, [], false));
    const delta: GraphDelta = {
      canvasId: this.canvasId,
      kind,
      command,
      modelBatch: modelOperationId
        ? { operationId: modelOperationId, committedAt: updated.committed_at.toISOString() }
        : null,
      graphRevision: updated.graph_revision,
      nodes: upserts,
      deletedNodeIds: nodes.filter((n) => !n.after).map((n) => n.id),
      edges: edges.filter((e) => e.after).map((e) => edgeView(e.after)),
      deletedEdgeIds: edges.filter((e) => !e.after).map((e) => e.id),
    };
    const seq = await canvasEvent(this.tx, this.canvasId, "graph.changed", delta);
    const changed = nodes
      .filter(
        (n) =>
          kind !== "move" &&
          n.after &&
          (!n.before ||
            n.before.asset_id !== n.after.asset_id ||
            ["text", "resource", "todo", "alt"].some(
              (key) => JSON.stringify(n.before.body[key]) !== JSON.stringify(n.after.body[key]),
            )),
      )
      .map((n) => n.id);
    if (changed.length)
      await this.tx.query(
        `insert into schedules(id,canvas_id,agent_id,kind,next_due_at,spec,dedupe_key)
      select 'change-'||a.node_id,$1,a.node_id,'resource_change',now()+interval '10 seconds',jsonb_build_object('sourceSeq',$3::text,'causeId',(select cause_id from runs where id=$5)),'change-'||a.node_id
      from agent_configs a join nodes n on n.id=a.node_id where n.canvas_id=$1 and a.enabled and a.node_id<>$4 and a.node_id=any($2::text[])
      on conflict(dedupe_key) do update set next_due_at=excluded.next_due_at,spec=excluded.spec,enabled=true`,
        [
          this.canvasId,
          [...effective]
            .filter(([, grants]) => grants.some((g) => changed.includes(g.resource_id)))
            .map(([id]) => id),
          seq,
          source?.agentId ?? "",
          source?.runId ?? null,
        ],
      );
    return {
      graphRevision: updated.graph_revision as number,
      canvasSeq: seq,
      delta,
      affectedNodeIds: nodes.map((n) => n.id),
      undoPatch: { nodes, edges, grants } satisfies UndoPatch,
    };
  }
}
