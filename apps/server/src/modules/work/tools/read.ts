import { Type } from "typebox";
import { readSkill } from "../../../adapters/host/capabilities.js";
import { DomainError, digest, id } from "../../../adapters/postgres/database.js";
import type { ExecutionTool, ToolResult } from "../../execution/tool-calls.js";
import { readObservationReader } from "../evidence/read-access.js";
import { observedRead } from "../evidence/read-observations.js";
import { idParameter, object, type ToolContext, tool } from "./context.js";
import { nodeReader } from "./node-read.js";

type Kind = "path" | "node" | "skill";
/** Cursors freeze source and position; every page still uses the original authorization path. */
export function readTools(context: ToolContext, pathReader: ExecutionTool): ExecutionTool[] {
  const { text, registry, ctx, input } = context;
  const sources: Record<Kind, Pick<ExecutionTool, "execute" | "normalize" | "prepare">> = {
    path: pathReader,
    node: nodeReader(context),
    skill: { execute: readSkill },
  };
  const definition = tool(
    "read",
    text(
      "Open exactly one path, nodeId or indexed skillId with flat fields. Use read_next({cursor:nextCursor}) for continuation. Text line and PDF page start at 1; image frame starts at 0. characterOffset is a zero-based text offset for node/skill only. mode defaults to auto; text omits images. Directory accepts auto/text without positions. positioning means scanning, not returned content. Optional sourceVersion requires that exact version; otherwise reopening reads the current version.",
      "用扁平字段打开恰好一个 path、nodeId 或已索引 skillId。续读使用 read_next({cursor:nextCursor})。文本 line、PDF page 从 1 开始，图片 frame 从 0 开始。characterOffset 是节点或 Skill 正文从 0 开始的字符位置，不用于路径。mode 默认 auto；text 不渲染图片。目录接受 auto/text，不接受定位字段。positioning 表示仍在扫描，尚未返回正文。可用 sourceVersion 指定已知版本；省略时重新打开当前版本。",
    ),
    object({
      path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
      nodeId: Type.Optional(idParameter),
      skillId: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
      sourceVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      line: Type.Optional(Type.Integer({ minimum: 1 })),
      page: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
      frame: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
      characterOffset: Type.Optional(Type.Integer({ minimum: 0 })),
      mode: Type.Optional(Type.Union(["auto", "text", "image"].map((v) => Type.Literal(v)))),
    }),
    "read",
    execute,
  );
  definition.normalize = async (args) => {
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
      (kind === "skill" && args.line !== undefined) ||
      (args.line !== undefined && args.characterOffset !== undefined) ||
      (kind === "path" && args.characterOffset !== undefined) ||
      (args.frame !== undefined && args.characterOffset !== undefined) ||
      (kind === "skill" && [args.page, args.frame, args.mode].some((v) => v !== undefined))
    )
      throw new DomainError(
        "READ_POSITION",
        "Use positions only for the corresponding file/media type / 仅为对应文件或媒体类型提供定位字段",
      );
    let value: Record<string, any> = {
      ...(kind === "node" ? { nodeId: args.nodeId } : { path: args[key] }),
      ...(args.characterOffset !== undefined ? { offset: args.characterOffset } : {}),
      ...(kind === "node" && args.characterOffset !== undefined
        ? { characterOffset: args.characterOffset }
        : {}),
      ...Object.fromEntries(
        ["line", "page", "frame", "mode", "sourceVersion"]
          .filter((k) => args[k] !== undefined)
          .map((k) => [k, args[k]]),
      ),
    };
    if (sources[kind].normalize) value = await sources[kind].normalize!(value);
    return {
      target: { kind, [key]: kind === "path" ? value.path : args[key] },
      input: value,
      sourceVersion: args.sourceVersion,
    };
  };
  definition.prepare = (tx, call, logical, args) =>
    sources[args.target.kind as Kind].prepare?.(tx, call, logical, args.input) ??
    Promise.resolve(undefined);
  const next = tool(
    "read_next",
    text(
      "Continue a successful read using only its nextCursor. Every page checks current access and source version. positioning means scanning continues, not that the content was read. An expired cursor requires reopening the source; use its recorded source version and position when available.",
      "仅用上次成功读取返回的 nextCursor 续读。每页重新校验当前权限和来源版本。positioning 表示仍在定位，不代表已读正文。游标过期后重新打开来源，并使用已记录的来源版本和位置。",
    ),
    object({ cursor: idParameter }),
    "read",
    execute,
  );
  next.normalize = async (args) => {
    const cursor = (
      await registry.graph.db.pool.query(
        "select target,input,source_version,expires_at>now() as valid from read_cursors where id=$1 and canvas_id=$2 and conversation_id=$3",
        [args.cursor, ctx.run.canvas_id, input.conversationId],
      )
    ).rows[0];
    if (!cursor?.valid) {
      const visible =
        cursor &&
        (await (
          await readObservationReader(registry.graph.db.pool, input.conversationId, registry.host)
        )(cursor.target));
      throw new DomainError(
        "READ_CURSOR_EXPIRED",
        "Cursor unavailable; use read to reopen the recorded source / 游标不可用；用 read 重新打开已记录的来源",
        visible ? expiredCursorDetails(cursor) : undefined,
      );
    }
    const origin = sources[cursor.target.kind as Kind];
    const normalized = origin.normalize ? await origin.normalize(cursor.input) : cursor.input;
    if (cursor.target.kind === "path" && normalized.path !== cursor.target.path)
      throw new DomainError("SOURCE_CHANGED", "Path changed; reopen / 路径已变化，请重新打开");
    return { target: cursor.target, input: normalized, sourceVersion: cursor.source_version };
  };
  next.prepare = definition.prepare;
  function expiredCursorDetails(cursor: any) {
    const { kind, ...target } = cursor.target;
    const { position, page, frame, mode, offset } = cursor.input;
    return {
      source: cursor.target,
      sourceVersion: cursor.source_version,
      position: position ?? { offset, page, frame },
      reopen: {
        ...target,
        sourceVersion: cursor.source_version,
        ...(mode !== undefined ? { mode } : {}),
        ...(page !== undefined ? { page } : {}),
        ...(frame !== undefined ? { frame } : {}),
        ...(kind !== "skill" && position
          ? { line: Math.max(position.line, position.targetLine) }
          : {}),
        ...(kind !== "path" && offset !== undefined ? { characterOffset: offset } : {}),
      },
    };
  }
  async function execute(call: string, args: any, signal: AbortSignal) {
    const output = await sources[args.target.kind as Kind].execute(call, args.input, signal);
    return continuation(output, args);
  }
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
        characterOffset: _characterOffset,
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
    const observation = observedRead(args.target.kind, data, output, version, cursor);
    return {
      ...output,
      details: { ...output.details, ...(observation ? { readObservation: observation } : {}) },
      content: [
        {
          type: "text",
          text: JSON.stringify({ ...body, sourceVersion: version, nextCursor: cursor }),
        },
        ...output.content.slice(1),
      ],
    };
  }
  return [definition, next];
}
