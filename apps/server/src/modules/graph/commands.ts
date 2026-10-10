import type {
  CreateNodeRequest,
  GraphMutationResponse,
  NodeResponse,
  UpdateNodeRequest,
} from "@intrica/contracts";
import {
  canvasEvent,
  type Database,
  DomainError,
  digest,
  id,
  type Tx,
} from "../../adapters/postgres/database.js";
import { roleRank } from "../access/intents.js";
import { reconcileApprovals } from "../access/lifecycle.js";
import { type Actor, actorId, authorize, OWNER } from "../access/policy.js";
import { cancelAgents } from "../execution/cancellation.js";
import { copyNodes } from "./copy.js";
import { GraphMutation, type UndoPatch } from "./mutation.js";
import { canvasView, GraphQueries } from "./queries.js";

export class GraphCommands {
  readonly queries: GraphQueries;
  constructor(readonly db: Database) {
    this.queries = new GraphQueries(db);
  }
  async command<T>(
    canvasId: string,
    key: string,
    kind: string,
    input: unknown,
    actor: Actor,
    fn: (m: GraphMutation) => Promise<T>,
    modelOperationId: string | null = null,
  ): Promise<T & GraphMutationResponse> {
    return this.db.canvas(canvasId, async (tx) => {
      const prior = (
        await tx.query(
          "select * from commands where canvas_id=$1 and actor_id=$2 and command_key=$3",
          [canvasId, actorId(actor), key],
        )
      ).rows[0];
      const requestHash = digest({ kind, input });
      if (prior) {
        if (prior.request_hash !== requestHash)
          throw new DomainError("IDEMPOTENCY_CONFLICT", "请求键已用于不同操作");
        return prior.response;
      }
      await authorize(tx, actor, canvasId, null, "read");
      const mutation = new GraphMutation(tx, canvasId, actor, this.queries);
      const value = await fn(mutation);
      const commandId = id("command");
      const changes = await mutation.finish(
        kind,
        undefined,
        { id: commandId, requestId: key },
        modelOperationId,
      );
      const response = {
        ...value,
        graphRevision: changes.graphRevision,
        graphOpId: commandId,
        affectedNodeIds: changes.affectedNodeIds,
        canvasSeq: changes.canvasSeq,
        delta: changes.delta,
      };
      await tx.query(
        "insert into commands(id,canvas_id,actor_id,command_key,request_hash,response,undo_patch,kind) values($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          commandId,
          canvasId,
          actorId(actor),
          key,
          requestHash,
          JSON.stringify(response),
          JSON.stringify(changes.undoPatch),
          kind,
        ],
      );
      return response;
    });
  }
  async createCanvas(req: { title: string; idempotencyKey: string }): Promise<NodeResponse> {
    const canvasId = `canvas-${digest(req.idempotencyKey).slice(0, 24)}`;
    return this.db.transaction(async (tx) => {
      const inserted = (
        await tx.query(
          "insert into canvases(id,title) values($1,$2) on conflict do nothing returning *",
          [canvasId, req.title.trim()],
        )
      ).rows[0];
      const row =
        inserted ?? (await tx.query("select * from canvases where id=$1", [canvasId])).rows[0];
      if (row.title !== req.title.trim())
        throw new DomainError("IDEMPOTENCY_CONFLICT", "请求键已用于其他画布");
      if (inserted)
        await canvasEvent(tx, canvasId, "canvas.created", { id: canvasId, title: row.title });
      return { node: canvasView(row), graphRevision: row.graph_revision };
    });
  }
  async createNode(req: CreateNodeRequest, actor: Actor = OWNER, nameLanguage = "en") {
    const canvasId = await this.queries.canvasId(req.parentId);
    return this.command(canvasId, req.idempotencyKey, "node.create", req, actor, async (m) => {
      const nodeId = await m.insert({ ...req, nameLanguage });
      return { node: await this.queries.node(nodeId, m.tx) };
    });
  }
  async copyNodes(req: { nodeIds: string[]; idempotencyKey: string }) {
    const canvasId = await this.queries.canvasId(req.nodeIds[0]!);
    return this.command(canvasId, req.idempotencyKey, "node.copy", req, OWNER, (mutation) =>
      copyNodes(mutation, this.queries, req.nodeIds),
    );
  }
  async updateNode(nodeId: string, req: UpdateNodeRequest, actor: Actor = OWNER) {
    const canvasId = await this.queries.canvasId(nodeId);
    return this.command(
      canvasId,
      req.idempotencyKey,
      "node.update",
      { nodeId, ...req },
      actor,
      async (m) => {
        await m.update(nodeId, req, req.expectedRevision);
        return { node: await this.queries.node(nodeId, m.tx) };
      },
    );
  }
  async submitMove(req: any, actor: Actor = OWNER) {
    const canvasId = await this.queries.canvasId(req.targetParentId);
    return this.command(canvasId, req.idempotencyKey, "move", req, actor, async (m) => {
      const selected = new Set(req.moves.map((n: any) => n.nodeId));
      for (const item of req.moves) {
        const descendants = await this.queries.descendantIds(item.nodeId, m.tx);
        if (descendants.some((id) => selected.has(id)))
          throw new DomainError("ANCESTOR_IN_SELECTION", "不能同时移动父节点与其后代");
      }
      for (const item of req.moves)
        await m.move(
          item.nodeId,
          req.targetParentId,
          item.x,
          item.y,
          item.index,
          item.expectedLayoutVersion,
        );
      return {};
    });
  }
  async deleteNodes(req: any, actor: Actor = OWNER) {
    const prior = (
      await this.db.pool.query(
        "select response from commands where actor_id=$1 and command_key=$2 and request_hash=$3",
        [actorId(actor), req.idempotencyKey, digest({ kind: "node.delete", input: req })],
      )
    ).rows[0];
    if (prior) return prior.response;
    if (!req.nodeIds.length) throw new DomainError("VALIDATION", "请选择元素");
    const canvasId = await this.queries.canvasId(req.nodeIds[0]);
    return this.command(canvasId, req.idempotencyKey, "node.delete", req, actor, async (m) => {
      await m.deleteNodes(req.nodeIds);
      return {};
    });
  }
  async createLink(req: any, actor: Actor = OWNER) {
    const canvasId = await this.queries.canvasId(req.fromId);
    return this.command(canvasId, req.idempotencyKey, "link.create", req, actor, async (m) => {
      const edge = await m.link(
        req.fromId,
        req.toId,
        "user_link",
        undefined,
        undefined,
        actor.kind === "owner",
      );
      if (!edge) throw new DomainError("DUPLICATE_LINK", "连接已存在");
      return { edge };
    });
  }
  async createLinks(req: any, actor: Actor = OWNER) {
    const canvasId = await this.queries.canvasId(req.toId);
    return this.command(canvasId, req.idempotencyKey, "link.create", req, actor, async (m) => {
      const edges = [];
      for (const from of new Set<string>(req.fromIds)) {
        if (from === req.toId) continue;
        const e = await m.link(
          from,
          req.toId,
          "user_link",
          undefined,
          undefined,
          actor.kind === "owner",
        );
        if (e) edges.push(e);
      }
      return { edges };
    });
  }
  async deleteLink(edgeId: string, req: any) {
    const prior = (
      await this.db.pool.query(
        "select response from commands where actor_id='owner' and command_key=$1 and request_hash=$2",
        [req.idempotencyKey, digest({ kind: "link.delete", input: { edgeId, ...req } })],
      )
    ).rows[0];
    if (prior) return prior.response;
    const row = (await this.db.pool.query("select canvas_id from edges where id=$1", [edgeId]))
      .rows[0];
    if (!row) throw new DomainError("NOT_FOUND", "连接不存在");
    return this.command(
      row.canvas_id,
      req.idempotencyKey,
      "link.delete",
      { edgeId, ...req },
      OWNER,
      async (m) => {
        await m.deleteEdge(edgeId, req.expectedRevision);
        return {};
      },
    );
  }
  async renameCanvas(
    canvasId: string,
    req: { title: string; expectedTitle: string; idempotencyKey: string },
  ) {
    const title = req.title.trim();
    if (!title || title.length > 500)
      throw new DomainError("VALIDATION", "画布名称需为 1–500 个字符");
    return this.db.canvas(canvasId, async (tx) => {
      const hash = digest({ kind: "canvas.rename", ...req });
      const prior = (
        await tx.query(
          "select * from commands where canvas_id=$1 and actor_id='owner' and command_key=$2",
          [canvasId, req.idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== hash)
          throw new DomainError("IDEMPOTENCY_CONFLICT", "请求键已用于不同操作");
        return prior.response;
      }
      const current = (await tx.query("select title from canvases where id=$1", [canvasId]))
        .rows[0];
      if (current.title !== req.expectedTitle)
        throw new DomainError("VERSION_CONFLICT", "画布名称已被修改，请重新打开重命名");
      const row = (
        await tx.query(
          "update canvases set title=$2,graph_revision=graph_revision+1 where id=$1 returning graph_revision",
          [canvasId, title],
        )
      ).rows[0];
      const commandId = id("command");
      const response = {
        graphOpId: commandId,
        graphRevision: row.graph_revision,
        affectedNodeIds: [canvasId],
      };
      await tx.query(
        "insert into commands(id,canvas_id,actor_id,command_key,request_hash,response,undo_patch,kind) values($1,$2,'owner',$3,$4,$5,$6,'canvas.rename')",
        [
          commandId,
          canvasId,
          req.idempotencyKey,
          hash,
          JSON.stringify(response),
          JSON.stringify({ canvasTitle: { before: current.title, after: title } }),
        ],
      );
      await canvasEvent(tx, canvasId, "graph.reset", { reason: "canvas.rename", commandId });
      return response;
    });
  }
  async deleteCanvas(canvasId: string, req: any) {
    return this.db.canvas(
      canvasId,
      async (tx) => {
        const prior = (
          await tx.query(
            "select * from commands where canvas_id=$1 and actor_id='owner' and command_key=$2",
            [canvasId, req.idempotencyKey],
          )
        ).rows[0];
        if (prior) {
          if (prior.request_hash !== digest(req))
            throw new DomainError("IDEMPOTENCY_CONFLICT", "请求键已用于不同操作");
          return prior.response;
        }
        const current = (await tx.query("select deleted_at from canvases where id=$1", [canvasId]))
          .rows[0];
        if (current.deleted_at) throw new DomainError("NOT_FOUND", "画布已删除");
        const commandId = id("command");
        await cancelAgents(
          tx,
          (
            await tx.query("select n.id from nodes n where n.canvas_id=$1 and n.kind='agent'", [
              canvasId,
            ])
          ).rows.map((n) => n.id),
        );
        await tx.query(
          "update canvases set deleted_at=now(),graph_revision=graph_revision+1 where id=$1",
          [canvasId],
        );
        await tx.query(
          "update runs set cancel_requested_at=now() where canvas_id=$1 and state in ('queued','running','waiting')",
          [canvasId],
        );
        const result = { graphOpId: commandId, graphRevision: 0, affectedNodeIds: [canvasId] };
        await tx.query(
          "insert into commands(id,canvas_id,actor_id,command_key,request_hash,response,undo_patch,kind) values($1,$2,'owner',$3,$4,$5,$6,'canvas.delete')",
          [
            commandId,
            canvasId,
            req.idempotencyKey,
            digest(req),
            JSON.stringify(result),
            JSON.stringify({ canvas: true }),
          ],
        );
        await canvasEvent(tx, canvasId, "canvas.deleted", { id: canvasId });
        return result;
      },
      true,
    );
  }
  async undoGraphOp(commandId: string) {
    const command = (
      await this.db.pool.query("select * from commands where id=$1 and actor_id='owner'", [
        commandId,
      ])
    ).rows[0];
    if (!command) throw new DomainError("NOT_FOUND", "找不到可撤销的操作");
    return this.db.canvas(
      command.canvas_id,
      async (tx) => {
        const current = (
          await tx.query("select * from commands where id=$1 for update", [commandId])
        ).rows[0];
        if (current.undone)
          return { undoneGraphOpId: commandId, graphRevision: current.response.graphRevision };
        if (new Date(current.created_at).getTime() < Date.now() - 30 * 86400000)
          throw new DomainError("UNDO_CONFLICT", "操作已超过撤销保留时间");
        const mutation = new GraphMutation(tx, current.canvas_id, OWNER, this.queries);
        await mutation.capturePermissions();
        if (current.undo_patch?.canvas) {
          await tx.query(
            "update canvases set deleted_at=null,graph_revision=graph_revision+1 where id=$1",
            [current.canvas_id],
          );
        } else if (current.undo_patch?.canvasTitle) {
          const change = current.undo_patch.canvasTitle;
          const restored = await tx.query(
            "update canvases set title=$2 where id=$1 and title=$3 and deleted_at is null returning id",
            [current.canvas_id, change.before, change.after],
          );
          if (!restored.rowCount)
            throw new DomainError("UNDO_CONFLICT", "画布名称已变化或画布已删除，不能覆盖后续修改");
        } else await restore(tx, current.undo_patch as UndoPatch);
        if (current.kind === "operation.commit") {
          await tx.query(
            "update proposals set decisions=decisions-$2::text[],version=version+1 where id=$1",
            [current.response.proposalId, current.response.candidateIds],
          );
          await canvasEvent(tx, current.canvas_id, "proposal.changed", {
            runId: current.response.runId,
            id: current.response.proposalId,
          });
        }
        await mutation.reconcilePermissions();
        for (const item of current.undo_patch?.nodes ?? [])
          if (
            item.before?.agent &&
            (!item.after || item.before.content_version !== item.after.content_version)
          )
            await mutation.syncSchedule(item.id, item.before.agent);
        await reconcileApprovals(tx, current.canvas_id);
        await tx.query("update commands set undone=true where id=$1", [commandId]);
        const revision = (
          await tx.query(
            "update canvases set graph_revision=graph_revision+1 where id=$1 returning graph_revision",
            [current.canvas_id],
          )
        ).rows[0].graph_revision;
        await canvasEvent(tx, current.canvas_id, "graph.reset", { reason: "undo", commandId });
        return { undoneGraphOpId: commandId, graphRevision: revision };
      },
      true,
    );
  }
}
async function restore(tx: Tx, patch: UndoPatch) {
  if (!patch) throw new DomainError("UNDO_CONFLICT", "此操作不可撤销");
  if (patch.grants.some((g) => !("before" in g)))
    throw new DomainError("UNDO_CONFLICT", "旧版授权操作不能撤销，请编辑当前权限");
  for (const g of patch.grants) {
    const current = (await tx.query("select * from grants where id=$1", [g.id])).rows[0];
    if (g.after ? !current || current.version !== g.after.version : Boolean(current))
      throw new DomainError("UNDO_CONFLICT", "授权已被后续操作修改");
    if (
      g.before &&
      !g.after &&
      (
        await tx.query(
          "select 1 from grants where subject_id=$1 and resource_id=$2 and delegated_by is not distinct from $3",
          [g.before.subject_id, g.before.resource_id, g.before.delegated_by ?? null],
        )
      ).rowCount
    )
      throw new DomainError("UNDO_CONFLICT", "资源已有新的授权");
  }
  await cancelAgents(tx, [
    ...new Set([
      ...patch.grants
        .filter((g) => g.after && (!g.before || g.before.mode !== g.after.mode))
        .map((g) => g.after.subject_id),
      ...patch.nodes
        .filter(
          (n) =>
            n.after?.agent &&
            (!n.before?.agent?.enabled ||
              roleRank[n.before.agent.role as keyof typeof roleRank] <
                roleRank[n.after.agent.role as keyof typeof roleRank]),
        )
        .map((n) => n.id),
    ]),
  ]);
  const currentNodes = new Map<string, any>();
  for (const item of patch.nodes) {
    const row = (await tx.query("select * from nodes where id=$1", [item.id])).rows[0];
    currentNodes.set(item.id, row);
    const contentChanged =
      !item.before || item.before.content_version !== item.after?.content_version;
    const layoutChanged = !item.before || item.before.layout_version !== item.after?.layout_version;
    if (
      item.after
        ? !row ||
          (contentChanged && row.content_version !== item.after.content_version) ||
          (layoutChanged && row.layout_version !== item.after.layout_version)
        : Boolean(row)
    )
      throw new DomainError("UNDO_CONFLICT", "元素在操作后已变化，无法覆盖后续修改");
    if (!item.before) {
      const dependents = await tx.query(
        "select 1 from nodes where parent_id=$1 and not(id=any($2::text[])) union all select 1 from edges where (from_id=$1 or to_id=$1) and not(id=any($3::text[])) limit 1",
        [item.id, patch.nodes.map((n) => n.id), patch.edges.map((e) => e.id)],
      );
      if (dependents.rowCount) throw new DomainError("UNDO_CONFLICT", "后续操作已引用此元素");
    }
    if (
      item.before?.parent_id &&
      !patch.nodes.some((n) => n.id === item.before.parent_id && n.before) &&
      !(await tx.query("select 1 from nodes where id=$1", [item.before.parent_id])).rowCount
    )
      throw new DomainError("UNDO_CONFLICT", "原父级已不存在");
  }
  for (const item of patch.edges) {
    const row = (await tx.query("select version from edges where id=$1", [item.id])).rows[0];
    if (item.after ? !row || row.version !== item.after.version : Boolean(row))
      throw new DomainError("UNDO_CONFLICT", "连接在操作后已变化");
  }
  for (const item of patch.edges) await tx.query("delete from edges where id=$1", [item.id]);
  for (const item of patch.nodes) {
    let n = item.before;
    if (!n) {
      await tx.query("delete from nodes where id=$1", [item.id]);
      continue;
    }
    const contentChanged = !item.after || n.content_version !== item.after.content_version;
    const layoutChanged = !item.after || n.layout_version !== item.after.layout_version;
    const current = currentNodes.get(item.id);
    if (current)
      n = {
        ...n,
        ...(!contentChanged
          ? { body: current.body, content_version: current.content_version }
          : {}),
        ...(!layoutChanged
          ? {
              parent_id: current.parent_id,
              sort_key: current.sort_key,
              x: current.x,
              y: current.y,
              w: current.w,
              h: current.h,
              layout_version: current.layout_version,
            }
          : {}),
      };
    await tx.query(
      `insert into nodes(id,canvas_id,parent_id,sort_key,kind,body,x,y,w,h,content_version,layout_version,origin,asset_id,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      on conflict(id) do update set parent_id=excluded.parent_id,sort_key=excluded.sort_key,body=excluded.body,x=excluded.x,y=excluded.y,w=excluded.w,h=excluded.h,content_version=excluded.content_version,layout_version=excluded.layout_version`,
      [
        n.id,
        n.canvas_id,
        n.parent_id,
        n.sort_key,
        n.kind,
        JSON.stringify(n.body),
        n.x,
        n.y,
        n.w,
        n.h,
        contentChanged
          ? Math.max(n.content_version, item.after?.content_version ?? 0) + 1
          : n.content_version,
        layoutChanged
          ? Math.max(n.layout_version, item.after?.layout_version ?? 0) + 1
          : n.layout_version,
        n.origin,
        n.asset_id,
        n.created_at,
      ],
    );
    if (n.agent && contentChanged)
      await tx.query(
        "insert into agent_configs(node_id,config,enabled) values($1,$2,$3) on conflict(node_id) do update set config=excluded.config,enabled=excluded.enabled",
        [n.id, JSON.stringify(n.agent), n.agent.enabled],
      );
  }
  // Later moves may have put an old parent below this node. Validate the final
  // restored graph in this transaction; UNION also bounds traversal if it cycles.
  const cycle = await tx.query(
    `with recursive ancestors as (
      select id as start_id,id,parent_id from nodes where id=any($1::text[])
      union select a.start_id,n.id,n.parent_id from ancestors a join nodes n on n.id=a.parent_id
    ) select 1 from ancestors where parent_id=start_id limit 1`,
    [patch.nodes.map((item) => item.id)],
  );
  if (cycle.rowCount) throw new DomainError("UNDO_CONFLICT", "后续移动已改变层级，撤销会形成循环");
  for (const item of patch.nodes)
    if (
      item.before?.agent &&
      (!item.after || item.before.content_version !== item.after.content_version)
    ) {
      const n = item.before;
      if (n.conversation_id)
        await tx.query("update conversations set agent_id=$2 where id=$1", [
          n.conversation_id,
          n.id,
        ]);
    }
  for (const item of patch.edges)
    if (item.before) {
      const e = item.before;
      await tx.query(
        "insert into edges(id,canvas_id,from_id,to_id,kind,version,source_attempt_id,source_revision) values($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          e.id,
          e.canvas_id,
          e.from_id,
          e.to_id,
          e.kind,
          Math.max(e.version, item.after?.version ?? 0) + 1,
          e.source_attempt_id,
          e.source_revision,
        ],
      );
    }
  for (const item of patch.grants) {
    await tx.query("delete from grants where id=$1", [item.id]);
    const g = item.before;
    if (g)
      await tx.query(
        "insert into grants(id,canvas_id,subject_id,resource_id,mode,source_link_id,version,delegated_by,execution_mode) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          g.id,
          g.canvas_id,
          g.subject_id,
          g.resource_id,
          g.mode,
          g.source_link_id,
          Math.max(g.version, item.after?.version ?? 0) + 1,
          g.delegated_by ?? null,
          g.execution_mode ?? "none",
        ],
      );
  }
}
