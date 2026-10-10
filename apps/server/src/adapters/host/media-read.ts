import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { ToolResult } from "../../modules/execution/tool-calls.js";
import { DomainError } from "../postgres/database.js";
import { mediaKind, readMediaContent } from "./media-content.js";

export type ReadOptions = {
  path: string;
  mode?: "auto" | "text" | "image";
  frame?: number;
  frames?: number[];
  pages?: number[];
  thumbnail?: boolean;
  page?: number;
  pdfTextOffset?: number;
  pdfTextLimit?: number;
  offset?: number;
  column?: number;
  limit?: number;
};

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
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new DomainError("VALIDATION", "read 只支持普通文件");
    const header = Buffer.alloc(8192);
    const head = await handle.read(header, 0, header.length, 0);
    if (!mediaKind(header.subarray(0, head.bytesRead)))
      return await readMediaContent(
        header.subarray(0, head.bytesRead),
        args,
        signal,
        supportsVision,
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
  return readMediaContent(bytes, args, signal, supportsVision, { path: args.path });
}
