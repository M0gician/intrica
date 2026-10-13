import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { ToolResult } from "../../modules/execution/tool-calls.js";
import { DomainError } from "../postgres/database.js";
import { readImageBytes } from "./image-read.js";
import { pdfToolResult, readPdf } from "./pdf-reader.js";

export type ReadOptions = {
  path: string;
  mode?: "auto" | "text" | "image";
  frame?: number;
  page?: number;
  pdfTextOffset?: number;
  pdfTextLimit?: number;
  offset?: number;
  column?: number;
  limit?: number;
};

function imageSignature(bytes: Buffer) {
  return (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
    ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) ||
    (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
  );
}

/** Called only after the tool's normal path approval and execution-time recheck.
 * undefined means ordinary text; never infer media from an untrusted extension. */
export async function readMedia(
  args: ReadOptions,
  signal: AbortSignal,
  supportsVision: boolean,
): Promise<ToolResult | undefined> {
  signal.throwIfAborted();
  const handle = await open(
    args.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let bytes: Buffer;
  let pdf = false;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new DomainError("VALIDATION", "read 只支持普通文件");
    const header = Buffer.alloc(16);
    await handle.read(header, 0, header.length, 0);
    pdf = header.toString("ascii", 0, 5) === "%PDF-";
    if (pdf && args.frame !== undefined)
      throw new DomainError("VALIDATION", "PDF 使用从 1 开始的 page，不使用 frame");
    if (!pdf && args.page !== undefined) throw new DomainError("VALIDATION", "page 仅适用于 PDF");
    if (!pdf && args.mode === "text" && !imageSignature(header)) {
      if (args.frame !== undefined)
        throw new DomainError("VALIDATION", "frame 仅适用于图片，文本分页请使用 offset/limit");
      return;
    }
    if (!pdf && args.mode === "image" && !imageSignature(header))
      throw new DomainError("VALIDATION", "图片只支持 PNG、JPEG、WebP 和 GIF；其他媒体请先转换");
    if (!pdf && args.mode !== "image" && !imageSignature(header)) {
      if (args.frame !== undefined) throw new DomainError("VALIDATION", "非图片文件不能指定 frame");
      return;
    }
    if (!supportsVision && args.mode === "image")
      throw new DomainError(
        "VALIDATION",
        "当前模型不支持图像输入；请选择支持视觉的模型，不能将图片当作 UTF-8 文本读取",
      );
    if (
      (!pdf || args.mode === "image") &&
      [args.offset, args.column, args.limit].some((v) => v !== undefined)
    )
      throw new DomainError(
        "VALIDATION",
        "图片不支持文本分页 offset/column/limit；请用 frame 选择静态帧",
      );
    if (info.size > 20 * 1024 * 1024)
      throw new DomainError("VALIDATION", "图片和 PDF 必须为 20MB 以内普通文件");
    // A file growing after stat must not turn a bounded read into unbounded memory use.
    bytes = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < bytes.length) {
      signal.throwIfAborted();
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    if (count !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs)
      throw new DomainError("TARGET_CHANGED", "图片在读取期间发生变化，请重新读取");
    bytes = bytes.subarray(0, count);
  } finally {
    await handle.close();
  }
  if (pdf)
    return pdfToolResult(
      await readPdf(
        bytes,
        {
          ...(args.page !== undefined ? { page: args.page } : {}),
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
          ...(args.column !== undefined ? { column: args.column } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          render: supportsVision && args.mode !== "text",
          ...(args.pdfTextOffset !== undefined ? { characterOffset: args.pdfTextOffset } : {}),
          ...(args.pdfTextLimit !== undefined ? { characterLimit: args.pdfTextLimit } : {}),
        },
        signal,
      ),
      { path: args.path },
    );
  return readImageBytes(bytes, args, signal, supportsVision, { path: args.path });
}
