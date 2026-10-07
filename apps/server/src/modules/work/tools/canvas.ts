import { setTodoItem, todoItems } from "@intrica/contracts";
import { Type } from "typebox";
import { canonicalPath } from "../../../adapters/host/sandbox.js";
import { DomainError } from "../../../adapters/postgres/database.js";
import { agentIdentity, grantsFor } from "../../access/policy.js";
import { result } from "../../execution/tool-calls.js";
import { createArtifact, requireArtifactFile } from "../artifact-delivery.js";
import { object, idParameter as string, type ToolContext, tool } from "./context.js";
import { resourcePermission } from "./resource-access.js";

export function canvasTools(context: ToolContext) {
  const { registry, ctx, actor, text, requireResource } = context;
  const readCanvas = tool(
    "read_canvas",
    text(
      "Page through the canvas agent directory and authorized resource index; use read with a node target for full content.",
      "按页查看当前画布的 Agent 名录和已授权资源索引；使用 read 的 node 目标读取全文。",
    ),
    Type.Object({
      query: Type.Optional(Type.String({ maxLength: 200 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })),
    }),
    "read",
    async (_call, args) => {
      const grants =
        actor.kind === "agent" ? await grantsFor(registry.graph.db.pool, actor.agentId) : null;
      const allowed =
        grants && actor.kind === "agent"
          ? [actor.agentId, ...grants.map((g) => g.resource_id)]
          : null;
      const rows = (
        await registry.graph.db.pool.query(
          "select id,kind,parent_id,body->>'title' as title,case when kind='agent' then '' else left(coalesce(body->>'summary',body->>'text',''),120) end as excerpt from nodes where canvas_id=$1 and ($2::text[] is null or id=any($2) or kind='agent') and ($3='' or body->>'title' ilike '%'||$3||'%') order by sort_key,id offset $4 limit $5",
          [ctx.run.canvas_id, allowed, args.query ?? "", args.offset ?? 0, (args.limit ?? 20) + 1],
        )
      ).rows;
      return result({
        nodes: rows.slice(0, args.limit ?? 20),
        nextOffset:
          rows.length > (args.limit ?? 20) ? (args.offset ?? 0) + (args.limit ?? 20) : null,
      });
    },
  );
  const update = tool(
    "update_node",
    text(
      "Update a canvas node at expectedRevision. patch.kind=content replaces selected fields; todo_item updates one zero-based checkbox in the original text. These changes cannot be combined.",
      "按 expectedRevision 更新画布节点。patch.kind=content 修改所选字段；todo_item 按从 0 开始的序号修改原文中的一个复选项。两种修改不能混用。",
    ),
    object({
      nodeId: string,
      expectedRevision: Type.Integer({ minimum: 1 }),
      patch: Type.Union([
        object(
          {
            kind: Type.Literal("content"),
            title: Type.Optional(Type.String({ maxLength: 500 })),
            text: Type.Optional(Type.String({ maxLength: 50000 })),
            summary: Type.Optional(Type.String({ maxLength: 50000 })),
            completed: Type.Optional(Type.Boolean()),
          },
          { minProperties: 2 },
        ),
        object({
          kind: Type.Literal("todo_item"),
          itemIndex: Type.Integer({ minimum: 0 }),
          completed: Type.Boolean(),
        }),
      ]),
    }),
    "graph",
    async (call, args) => {
      await requireResource(args.nodeId, "write");
      const { kind, completed, ...fields } = args.patch;
      let patch: Record<string, unknown>;
      if (kind === "todo_item") {
        const node = await registry.graph.queries.node(args.nodeId);
        if (node.kind !== "todo") throw new DomainError("VALIDATION", "目标不是待办节点");
        const items = todoItems(node.text ?? "");
        const item = items[fields.itemIndex];
        if (!item)
          throw new DomainError(
            "VALIDATION",
            `待办序号超出范围：共 ${items.length} 项，从 0 开始。请读取最新内容。`,
          );
        patch = { text: setTodoItem(node.text ?? "", item.line, completed) };
      } else patch = { ...fields, ...(completed !== undefined ? { todo: { completed } } : {}) };
      return result(
        await registry.graph.updateNode(
          args.nodeId,
          {
            ...patch,
            expectedRevision: args.expectedRevision,
            idempotencyKey: `tool-${ctx.run.id}-${call}`,
          },
          actor,
        ),
      );
    },
  );
  update.prepare = (tx, callId, _logical, args) =>
    resourcePermission(context, tx, callId, args.nodeId, "write", "Update canvas content");
  const create = tool(
    "create_artifact",
    text(
      "Save a text or todo artifact. path attaches an existing file to text; it never writes a file. completed applies only to todo. shareWithManagers=false saves privately without activating other Agents. Saving does not send a report or prove completion.",
      "保存 text 或 todo 产物。path 仅为 text 附加已有文件，不写入文件。completed 仅适用于 todo。shareWithManagers=false 私有保存且不启动其他 Agent。保存不等于提交报告或完成任务。",
    ),
    object(
      {
        kind: Type.Union([Type.Literal("text"), Type.Literal("todo")]),
        title: Type.String({ minLength: 1, maxLength: 500 }),
        text: Type.Optional(Type.String({ maxLength: 50000 })),
        path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
        completed: Type.Optional(Type.Boolean()),
        shareWithManagers: Type.Optional(Type.Boolean()),
      },
      {
        anyOf: [
          { properties: { kind: { const: "text" } }, not: { required: ["completed"] } },
          { properties: { kind: { const: "todo" } }, not: { required: ["path"] } },
        ],
      },
    ),
    "graph",
    (call, args) => createArtifact(registry, ctx, actor, call, args, args.kind),
  );
  if (actor.kind === "agent") {
    create.normalize = async (args) => ({
      ...args,
      ...(args.path
        ? { path: await canonicalPath(args.path, (await registry.host.scope(actor)).cwd) }
        : {}),
    });
    create.prepare = async (tx, callId, _logical, args) => {
      const identity = await agentIdentity(tx, actor.agentId);
      if (args.path) {
        if (await registry.host.protectedPath(args.path))
          throw new DomainError("FORBIDDEN", "不能连接 Server 管理目录");
        await requireArtifactFile(args.path);
        try {
          await registry.host.assertPath(actor, args.path, false, tx);
        } catch (error) {
          if (!(error instanceof DomainError) || error.code !== "FORBIDDEN") throw error;
          return registry.access.gate(
            tx,
            actor,
            callId,
            {
              kind: "path",
              path: args.path,
              directory: false,
              ...(identity.config.role === "read" ? { requiredRole: "write" as const } : {}),
            },
            "Attach artifact file",
          );
        }
      }
      if (identity.config.role === "read")
        return registry.access.gate(
          tx,
          actor,
          callId,
          { kind: "role", role: "write" },
          "Save artifact",
        );
    };
  }
  return [readCanvas, update, create];
}
