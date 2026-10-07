import type { Node, SnapshotResponse } from "@intrica/contracts";
import { type Database, DomainError, type Sql } from "../../adapters/postgres/database.js";

export type NodeRow = {
  id: string;
  canvas_id: string;
  parent_id: string | null;
  sort_key: string;
  kind: Node["kind"];
  body: Record<string, any>;
  x: number;
  y: number;
  w: number;
  h: number;
  content_version: number;
  layout_version: number;
  origin: "user" | "model";
  asset_id: string | null;
  created_at: Date;
  agent?: Node["agent"];
  manager_id?: string | null;
};
export const nodeColumns = "n.*, a.config as agent, parent_agent.node_id as manager_id";
export const nodeJoin =
  "nodes n left join agent_configs a on a.node_id=n.id left join agent_configs parent_agent on parent_agent.node_id=n.parent_id";
export function nodeView(row: NodeRow, childOrder: string[] = [], full = true): Node {
  const body = row.body;
  return {
    id: row.id,
    kind: row.kind,
    canvasId: row.canvas_id,
    // A scope id in the renderer can be either a canvas or a node. Canvas scopes
    // are projections, never rows in nodes and never part of the ownership tree.
    parentId: row.parent_id ?? row.canvas_id,
    childOrder,
    position: { x: row.x, y: row.y, width: row.w, height: row.h },
    lifecycle: row.origin === "model" ? "committed" : "user",
    origin: row.origin,
    revision: row.content_version,
    layoutVersion: row.layout_version,
    sortKey: String(row.sort_key),
    contentLoaded: full,
    createdAt: new Date(row.created_at).toISOString(),
    ...body,
    ...(typeof body.text === "string" && !full ? { text: body.text.slice(0, 400) } : {}),
    ...(typeof body.summary === "string" && !full ? { summary: body.summary.slice(0, 400) } : {}),
    ...(row.agent ? { agent: row.agent, managerId: row.manager_id ?? null } : {}),
    ...(row.asset_id ? { assetId: row.asset_id, assetVersion: 1 } : {}),
  };
}
export function edgeView(row: any) {
  return {
    id: row.id,
    from: row.from_id,
    to: row.to_id,
    type: row.kind,
    directed: row.kind === "derived_from",
    confirmed: true as const,
    revision: row.version,
    operationId: row.source_attempt_id ?? null,
    sourceRevision: row.source_revision ?? null,
  };
}
export function canvasView(row: any, childOrder: string[] = []): Node {
  return {
    id: row.id,
    canvasId: row.id,
    layoutVersion: 0,
    sortKey: "0",
    contentLoaded: true,
    kind: "group",
    parentId: null,
    title: row.title,
    childOrder,
    position: { x: 0, y: 0, width: 1, height: 1 },
    lifecycle: "user",
    origin: "user",
    revision: row.graph_revision,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
export class GraphQueries {
  constructor(readonly db: Database) {}
  async canvasId(scopeId: string, sql: Sql = this.db.pool): Promise<string> {
    const { rows } = await sql.query(
      "select id as canvas_id from canvases where id=$1 and deleted_at is null union all select n.canvas_id from nodes n join canvases c on c.id=n.canvas_id where n.id=$1 and c.deleted_at is null",
      [scopeId],
    );
    if (!rows[0]) throw new DomainError("NOT_FOUND", "元素或画布不存在");
    return rows[0].canvas_id;
  }
  async node(nodeId: string, sql: Sql = this.db.pool): Promise<Node> {
    const { rows } = await sql.query(`select ${nodeColumns} from ${nodeJoin} where n.id=$1`, [
      nodeId,
    ]);
    if (!rows[0]) {
      const canvases = await sql.query(
        "select * from canvases where id=$1 and deleted_at is null",
        [nodeId],
      );
      if (!canvases.rows[0]) throw new DomainError("NOT_FOUND", "元素不存在");
      const children = await sql.query(
        "select id from nodes where canvas_id=$1 and parent_id is null order by sort_key,id",
        [nodeId],
      );
      return canvasView(
        canvases.rows[0],
        children.rows.map((n) => n.id),
      );
    }
    const children = await sql.query(
      "select id from nodes where parent_id=$1 order by sort_key,id",
      [nodeId],
    );
    return nodeView(
      rows[0],
      children.rows.map((n) => n.id),
    );
  }
  async children(parentId: string, sql: Sql = this.db.pool): Promise<Node[]> {
    const canvasId = await this.canvasId(parentId, sql);
    const { rows } = await sql.query(
      `select ${nodeColumns} from ${nodeJoin} where n.canvas_id=$1 and n.parent_id is not distinct from $2 order by n.sort_key,n.id`,
      [canvasId, canvasId === parentId ? null : parentId],
    );
    return rows.map((row) => nodeView(row));
  }
  async descendantIds(nodeId: string, sql: Sql = this.db.pool): Promise<string[]> {
    return (
      await sql.query(
        "with recursive tree as(select id from nodes where parent_id=$1 union all select n.id from nodes n join tree t on n.parent_id=t.id) select id from tree order by id",
        [nodeId],
      )
    ).rows.map((n) => n.id);
  }
  async snapshot(requestedCanvasId?: string, full = false, sql?: Sql): Promise<SnapshotResponse> {
    const collect = async (tx: Sql): Promise<SnapshotResponse> => {
      const canvases = (
        await tx.query("select * from canvases where deleted_at is null order by created_at,id")
      ).rows;
      const current = canvases.find((c) => c.id === requestedCanvasId) ?? canvases[0];
      if (!current)
        return {
          nodes: [],
          edges: [],
          operations: [],
          candidateNodes: [],
          candidateContainers: [],
          graphRevision: 0,
          activeCanvasId: null,
          canvasSeq: "0",
          latestModelBatchAt: null,
          latestModelBatchOperationId: null,
        };
      // Project bodies in SQL so metadata requests do not fetch large text columns.
      const columns = full
        ? nodeColumns
        : `n.id,n.canvas_id,n.parent_id,n.sort_key,n.kind,n.x,n.y,n.w,n.h,n.content_version,n.layout_version,n.origin,n.asset_id,n.created_at,
        (n.body - 'text' - 'summary') || jsonb_build_object('text',left(n.body->>'text',400),'summary',left(n.body->>'summary',400)) as body,a.config as agent,parent_agent.node_id as manager_id`;
      const rows = (
        await tx.query(
          `select ${columns} from ${nodeJoin} where n.canvas_id=$1 order by n.sort_key,n.id`,
          [current.id],
        )
      ).rows;
      const byParent = new Map<string, string[]>();
      for (const n of rows) {
        const p = n.parent_id ?? n.canvas_id;
        const ids = byParent.get(p) ?? [];
        ids.push(n.id);
        byParent.set(p, ids);
      }
      const edgeRows = (await tx.query("select * from edges where canvas_id=$1", [current.id]))
        .rows;
      const latest = (
        await tx.query(
          "select created_at,response from commands where canvas_id=$1 and kind='operation.commit' and not undone order by created_at desc,id desc limit 1",
          [current.id],
        )
      ).rows[0];
      return {
        nodes: [
          ...canvases.map((c) => canvasView(c, byParent.get(c.id))),
          ...rows.map((n) => nodeView(n, byParent.get(n.id), full)),
        ],
        edges: edgeRows.map(edgeView),
        graphRevision: current.graph_revision,
        activeCanvasId: current.id,
        canvasSeq: String(current.event_seq),
        operations: [],
        candidateNodes: [],
        candidateContainers: [],
        latestModelBatchAt: latest ? new Date(latest.created_at).toISOString() : null,
        latestModelBatchOperationId: latest?.response.runId ?? null,
      };
    };
    return sql ? collect(sql) : this.db.transaction(collect, true);
  }
}
