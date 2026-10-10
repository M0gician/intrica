import { Type } from "typebox";
import { Value } from "typebox/value";
import { readSkill } from "../../../adapters/host/capabilities.js";
import { DomainError, digest } from "../../../adapters/postgres/database.js";
import type { ExecutionTool, ToolResult } from "../../execution/tool-calls.js";
import { idParameter, object, type ToolContext, tool } from "./context.js";
import { nodeReader } from "./node-read.js";

const position = object({
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  column: Type.Optional(Type.Integer({ minimum: 0 })),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
  mode: Type.Optional(
    Type.Union([Type.Literal("auto"), Type.Literal("text"), Type.Literal("image")]),
  ),
});
const cursorSchema = object({
  target: Type.String(),
  position,
  contentHash: Type.Optional(Type.String()),
});
type Kind = "path" | "node" | "skill";

/** Continuation identifies a position, never an authorization grant. */
export function readTool(context: ToolContext, pathReader: ExecutionTool) {
  const { text } = context;
  const sources: Record<Kind, Pick<ExecutionTool, "execute" | "normalize" | "prepare">> = {
    path: pathReader,
    node: nodeReader(context),
    skill: { execute: readSkill },
  };
  const source = (kind: Kind) => sources[kind];
  const definition = tool(
    "read",
    text(
      "Read a path (file or directory), canvas node, or indexed skillId (its catalog path). Permissions are separate for each target. Follow nextCursor to finish. line is one-based for file text; page is one-based for PDFs; frame is zero-based for images. Omit positions with cursor. mode=text omits images; image requires vision. Results preserve images and node revisions. No OCR.",
      "读取路径（文件或目录）、画布节点或已索引 skillId（目录索引中的路径）。各目标分别检查权限。沿 nextCursor 续读。文件 line 和 PDF page 从 1 开始，图片 frame 从 0 开始；cursor 不能与定位字段混用。text 不渲染图片；image 需要视觉能力。保留图片及节点版本，不执行 OCR。",
    ),
    object({
      target: Type.Union([
        object({
          kind: Type.Literal("path"),
          path: Type.String({ minLength: 1, maxLength: 4096 }),
        }),
        object({ kind: Type.Literal("node"), nodeId: idParameter }),
        object({
          kind: Type.Literal("skill"),
          skillId: Type.String({ minLength: 1, maxLength: 4096 }),
        }),
      ]),
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
      line: Type.Optional(Type.Integer({ minimum: 1 })),
      page: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
      frame: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
      frames: Type.Optional(
        Type.Array(Type.Integer({ minimum: 0, maximum: 10000 }), {
          minItems: 1,
          maxItems: 4,
          uniqueItems: true,
        }),
      ),
      pages: Type.Optional(
        Type.Array(Type.Integer({ minimum: 1, maximum: 2000 }), {
          minItems: 1,
          maxItems: 4,
          uniqueItems: true,
        }),
      ),
      thumbnail: Type.Optional(Type.Boolean()),
      mode: Type.Optional(
        Type.Union([Type.Literal("auto"), Type.Literal("text"), Type.Literal("image")]),
      ),
    }),
    "read",
    async (call, args, signal) => {
      const output = await source(args.target.kind).execute(call, args.input, signal);
      return continuation(output, args.target, args.input);
    },
  );
  definition.normalize = async (args) => {
    const kind: Kind = args.target.kind;
    if (
      args.cursor &&
      [args.line, args.page, args.frame, args.frames, args.pages, args.thumbnail].some(
        (v) => v !== undefined,
      )
    )
      throw new DomainError("VALIDATION", "cursor 不能与定位字段同时使用");
    if (
      (kind !== "path" && args.line !== undefined) ||
      (kind === "skill" &&
        [args.page, args.mode, args.frame, args.frames, args.pages, args.thumbnail].some(
          (v) => v !== undefined,
        ))
    )
      throw new DomainError("VALIDATION", "目标不接受此定位或显示选项");
    let input: Record<string, any> = {
      ...(kind === "node"
        ? { nodeId: args.target.nodeId }
        : { path: kind === "path" ? args.target.path : args.target.skillId }),
      ...(args.line !== undefined ? { line: args.line } : {}),
      ...(args.page !== undefined ? { page: args.page } : {}),
      ...(args.frame !== undefined ? { frame: args.frame } : {}),
      ...(args.frames ? { frames: args.frames } : {}),
      ...(args.pages ? { pages: args.pages } : {}),
      ...(args.thumbnail !== undefined ? { thumbnail: args.thumbnail } : {}),
      ...(args.mode !== undefined ? { mode: args.mode } : {}),
    };
    const origin = source(kind);
    if (origin.normalize) input = await origin.normalize(input);
    const target = kind === "path" ? { kind, path: input.path } : args.target;
    if (args.cursor) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(args.cursor, "base64url").toString("utf8"));
      } catch {
        throw new DomainError("VALIDATION", "读取游标无效");
      }
      if (!Value.Check(cursorSchema, decoded) || decoded.target !== digest(target))
        throw new DomainError("VALIDATION", "读取游标与目标不匹配");
      if (args.mode !== undefined && args.mode !== (decoded.position.mode ?? "auto"))
        throw new DomainError(
          "VALIDATION",
          "mode 与游标模式冲突；续读时省略 mode 或使用游标原模式",
        );
      if (
        (kind === "skill" && Object.keys(decoded.position).some((key) => key !== "offset")) ||
        (kind === "node" && decoded.position.column !== undefined)
      )
        throw new DomainError("VALIDATION", "读取游标位置不适用于此目标");
      input = { ...input, ...decoded.position, expectedContentHash: decoded.contentHash };
      if (decoded.position.mode === undefined) delete input.mode;
    }
    return { target, input };
  };
  definition.prepare = (tx, id, logical, args) =>
    source(args.target.kind).prepare?.(tx, id, logical, args.input) ?? Promise.resolve(undefined);
  return definition;
}

function continuation(
  output: ToolResult,
  target: Record<string, unknown>,
  input: Record<string, any>,
): ToolResult {
  const first = output.content[0];
  if (first?.type !== "text" || output.isError) return output;
  const data = JSON.parse(first.text);
  if (input.expectedContentHash && data.contentHash !== input.expectedContentHash)
    throw new DomainError(
      "TARGET_CHANGED",
      "Read source changed between pages; restart from the first page.",
    );
  let next: Record<string, number | string> | null = null;
  if (data.nextOffset != null)
    next = {
      offset: data.nextOffset,
      ...(data.nextColumn !== undefined ? { column: data.nextColumn } : {}),
      ...(data.page !== undefined ? { page: data.page } : {}),
    };
  else if (data.nextPage != null) next = { page: data.nextPage };
  if (next && input.mode !== undefined) next.mode = input.mode;
  const { nextOffset: _offset, nextColumn: _column, nextPage: _page, ...body } = data;
  return {
    ...output,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ...body,
          nextCursor: next
            ? Buffer.from(
                JSON.stringify({
                  target: digest(target),
                  position: next,
                  contentHash: data.contentHash,
                }),
              ).toString("base64url")
            : null,
        }),
      },
      ...output.content.slice(1),
    ],
  };
}
