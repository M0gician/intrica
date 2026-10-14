import { Type } from "typebox";
import { readSkill } from "../../../adapters/host/capabilities.js";
import { DomainError, digest, id } from "../../../adapters/postgres/database.js";
import type { ExecutionTool, ToolResult } from "../../execution/tool-calls.js";
import { idParameter, object, type ToolContext, tool } from "./context.js";
import { nodeReader } from "./node-read.js";

type Kind = "path" | "node" | "skill";
/** Cursors freeze source and position; every page still uses the original authorization path. */
export function readTool(context: ToolContext, pathReader: ExecutionTool) {
  const { text, registry, ctx, input } = context;
  const sources: Record<Kind, Pick<ExecutionTool, "execute" | "normalize" | "prepare">> = {
    path: pathReader,
    node: nodeReader(context),
    skill: { execute: readSkill },
  };
  const definition = tool(
    "read",
    text(
      "Read exactly one path, nodeId or indexed skillId using flat fields. For continuation, send only cursor. line is one-based for text, page one-based for PDF, frame zero-based for images. mode defaults to auto; text omits images. Directory accepts auto/text without positions. Follow nextCursor, including positioning responses for distant lines. Cursors expire and do not grant access. Source changes require reopening.",
      "用扁平字段读取恰好一个 path、nodeId 或已索引 skillId。续读只传 cursor。文本 line、PDF page 从 1 开始，图片 frame 从 0 开始。mode 默认 auto；text 不渲染图片。目录接受 auto/text，不接受定位字段。沿 nextCursor 续读；定位远处行时 positioning 表示仍在扫描。游标有期限、不授予权限；来源变化后重新打开。",
    ),
    object({
      path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
      nodeId: Type.Optional(idParameter),
      skillId: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
      cursor: Type.Optional(idParameter),
      line: Type.Optional(Type.Integer({ minimum: 1 })),
      page: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
      frame: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
      mode: Type.Optional(Type.Union(["auto", "text", "image"].map((v) => Type.Literal(v)))),
    }),
    "read",
    async (call, args, signal) => {
      const output = await sources[args.target.kind as Kind].execute(call, args.input, signal);
      return continuation(output, args);
    },
  );
  definition.normalize = async (args) => {
    if (args.cursor) {
      if (Object.keys(args).length !== 1)
        throw new DomainError(
          "READ_CURSOR_INPUT",
          "Continue with only {cursor} / 续读只传 {cursor}",
          { path: "/cursor" },
        );
      const cursor = (
        await registry.graph.db.pool.query(
          "select target,input,source_version from read_cursors where id=$1 and canvas_id=$2 and conversation_id=$3 and expires_at>now()",
          [args.cursor, ctx.run.canvas_id, input.conversationId],
        )
      ).rows[0];
      if (!cursor)
        throw new DomainError(
          "READ_CURSOR_EXPIRED",
          "Cursor unavailable; reopen the source / 游标不可用，请重新打开来源",
        );
      const origin = sources[cursor.target.kind as Kind];
      const normalized = origin.normalize ? await origin.normalize(cursor.input) : cursor.input;
      if (cursor.target.kind === "path" && normalized.path !== cursor.target.path)
        throw new DomainError("SOURCE_CHANGED", "Path changed; reopen / 路径已变化，请重新打开");
      return { target: cursor.target, input: normalized, sourceVersion: cursor.source_version };
    }
    const fields = ["path", "nodeId", "skillId"].filter((key) => args[key] !== undefined);
    if (fields.length !== 1)
      throw new DomainError(
        "READ_TARGET",
        "Choose exactly one path, nodeId or skillId / 恰选一个 path、nodeId 或 skillId",
        { path: "/path" },
      );
    const key = fields[0]!,
      kind: Kind = key === "path" ? "path" : key === "nodeId" ? "node" : "skill";
    if (
      (kind !== "path" && args.line !== undefined) ||
      (kind === "skill" && [args.page, args.frame, args.mode].some((v) => v !== undefined))
    )
      throw new DomainError(
        "READ_POSITION",
        "Use positions only for the corresponding file/media type / 仅为对应文件或媒体类型提供定位字段",
      );
    let value: Record<string, any> = {
      ...(kind === "node" ? { nodeId: args.nodeId } : { path: args[key] }),
      ...Object.fromEntries(
        ["line", "page", "frame", "mode"]
          .filter((k) => args[k] !== undefined)
          .map((k) => [k, args[k]]),
      ),
    };
    if (sources[kind].normalize) value = await sources[kind].normalize!(value);
    return { target: { kind, [key]: kind === "path" ? value.path : args[key] }, input: value };
  };
  definition.prepare = (tx, call, logical, args) =>
    sources[args.target.kind as Kind].prepare?.(tx, call, logical, args.input) ??
    Promise.resolve(undefined);
  async function continuation(output: ToolResult, args: any): Promise<ToolResult> {
    const first = output.content[0];
    if (first?.type !== "text" || output.isError) return output;
    const data = JSON.parse(first.text);
    const version =
      data.sourceVersion ??
      digest([
        data.id,
        data.revision?.content ?? data.revision,
        data.attachment,
        data.resource?.snapshot,
      ]);
    if (args.sourceVersion && version !== args.sourceVersion)
      throw new DomainError(
        "SOURCE_CHANGED",
        "Source changed; reopen without cursor / 来源已变化，请移除游标重新打开",
      );
    let next: Record<string, unknown> | null = null;
    if (data.nextPosition) next = { position: data.nextPosition };
    else if (data.nextOffset != null)
      next = {
        offset: data.nextOffset,
        ...(data.nextColumn !== undefined ? { column: data.nextColumn } : {}),
        ...(data.page !== undefined ? { page: data.page } : {}),
      };
    else if (data.nextPage != null) next = { page: data.nextPage };
    let cursor: string | null = null;
    if (next) {
      cursor = id("read");
      // Positions belong to one returned segment. A new PDF page starts at its
      // beginning instead of inheriting the last line/character offset.
      const {
        line: _line,
        offset: _offset,
        column: _column,
        position: _position,
        ...original
      } = args.input;
      const continuationInput = { ...original, ...next, sourceVersion: version };
      await registry.graph.db.canvas(ctx.run.canvas_id, async (tx) => {
        await tx.query(
          "delete from read_cursors where conversation_id=$1 and (expires_at<=now() or id in (select id from read_cursors where conversation_id=$1 order by created_at desc offset 127))",
          [input.conversationId],
        );
        await tx.query(
          "insert into read_cursors(id,canvas_id,conversation_id,target,input,source_version) values($1,$2,$3,$4,$5,$6)",
          [
            cursor,
            ctx.run.canvas_id,
            input.conversationId,
            JSON.stringify(args.target),
            JSON.stringify(continuationInput),
            version,
          ],
        );
      });
    }
    const { nextOffset: _o, nextColumn: _c, nextPage: _p, nextPosition: _n, ...body } = data;
    return {
      ...output,
      content: [
        { type: "text", text: JSON.stringify({ ...body, nextCursor: cursor }) },
        ...output.content.slice(1),
      ],
    };
  }
  return definition;
}
