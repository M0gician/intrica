import { createHash } from "node:crypto";
import sharp from "sharp";
import { result, type ToolResult } from "../../modules/execution/tool-results.js";
import { DomainError } from "../postgres/database.js";
import { sniffMime } from "./file-preview.js";
import type { ReadOptions } from "./media-read.js";
import { pdfToolResult, readPdf } from "./pdf-reader.js";

export function mediaKind(bytes: Buffer) {
  if (bytes.toString("ascii", 0, 5) === "%PDF-") return "pdf";
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
    ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) ||
    (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
  )
    return "image";
  if (sniffMime(bytes, "", true) === "image/svg+xml") return "image";
  return null;
}

const indices = (
  single: number | undefined,
  batch: number[] | undefined,
  first: number,
  max: number,
) => {
  if (single !== undefined && batch !== undefined)
    throw new DomainError("VALIDATION", "不能同时指定单项与批量位置");
  const values = batch ?? [single ?? first];
  if (
    !values.length ||
    values.length > 4 ||
    new Set(values).size !== values.length ||
    values.some((n) => !Number.isInteger(n) || n < first || n > max)
  )
    throw new DomainError("VALIDATION", `每次可读取 1–4 个不同的位置，范围为 ${first}–${max}`);
  return values;
};

/** Both node snapshots and authorized paths reach this reader only as bounded bytes. */
export async function readMediaContent(
  bytes: Buffer,
  args: Omit<ReadOptions, "path">,
  signal: AbortSignal,
  supportsVision: boolean,
  identity: Record<string, unknown> = {},
): Promise<ToolResult | undefined> {
  signal.throwIfAborted();
  const kind = mediaKind(bytes);
  if (!kind) {
    if (args.mode === "image")
      throw new DomainError(
        "VALIDATION",
        "图片只支持 PNG、JPEG、WebP、GIF 和 SVG；其他媒体请先转换",
      );
    if (
      args.page !== undefined ||
      args.pages ||
      args.frame !== undefined ||
      args.frames ||
      args.thumbnail
    )
      throw new DomainError("VALIDATION", "非图片或 PDF 文件不能指定页或帧");
    return;
  }
  if (bytes.length > 20 * 1024 * 1024)
    throw new DomainError("VALIDATION", "图片和 PDF 必须为 20MB 以内普通文件");
  const source = {
    ...identity,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
  };
  if (kind === "pdf") {
    if (args.frame !== undefined || args.frames)
      throw new DomainError("VALIDATION", "PDF 使用从 1 开始的 page，不使用 frame");
    if (args.mode === "image" && !supportsVision)
      throw new DomainError("VALIDATION", "当前模型不支持图像输入");
    const pages = indices(args.page, args.pages, 1, 2000);
    const values = [];
    let total = 0;
    for (const page of pages) {
      const value = await readPdf(
        bytes,
        {
          page,
          render: supportsVision && args.mode !== "text",
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
          ...(args.column !== undefined ? { column: args.column } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.pdfTextOffset !== undefined ? { characterOffset: args.pdfTextOffset } : {}),
          ...(args.pdfTextLimit !== undefined ? { characterLimit: args.pdfTextLimit } : {}),
        },
        signal,
      );
      if (args.thumbnail && value.image)
        value.image = (
          await sharp(Buffer.from(value.image, "base64"))
            .resize({ width: 320, height: 320, fit: "inside", withoutEnlargement: true })
            .png()
            .toBuffer()
        ).toString("base64");
      total += value.image ? Buffer.byteLength(value.image, "base64") : 0;
      if (total > 8 * 1024 * 1024)
        throw new DomainError("VALIDATION", "批量预览过大，请减少页数或使用缩略图");
      values.push(value);
    }
    const single = pdfToolResult(values[0]!, source);
    const capabilities = {
      text: true,
      pages: true,
      frames: false,
      thumbnail: true,
      download: true,
    };
    if (!args.pages) {
      single.content[0] = {
        type: "text",
        text: JSON.stringify({
          ...JSON.parse((single.content[0] as { text: string }).text),
          capabilities,
        }),
      };
      single.details = { ...single.details, ...source, capabilities };
      return single;
    }
    return {
      details: { mediaType: "pdf", ...source, capabilities },
      content: [
        ...result({
          ...source,
          mediaType: "pdf",
          capabilities,
          pages: values.map(({ image: _image, ...v }) => v),
          note: "Static page inspection; no OCR.",
        }).content,
        ...values.flatMap((v) =>
          v.image ? [{ type: "image" as const, mimeType: "image/png", data: v.image }] : [],
        ),
      ],
    };
  }
  if (args.page !== undefined || args.pages)
    throw new DomainError("VALIDATION", "page 仅适用于 PDF");
  if ([args.offset, args.column, args.limit].some((v) => v !== undefined))
    throw new DomainError("VALIDATION", "图片不支持文本分页；请使用 frame 或 frames");
  if (!supportsVision && args.mode !== "text")
    throw new DomainError("VALIDATION", "当前模型不支持图像输入；请使用 text 查看媒体信息");
  try {
    const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 })
      .timeout({ seconds: 10 })
      .metadata();
    const count = metadata.pages ?? 1;
    if (args.frame !== undefined && args.frame >= count)
      throw new DomainError("VALIDATION", `图片共 ${count} 帧，frame 从 0 开始`);
    const selected = indices(args.frame, args.frames, 0, count - 1);
    const images: ToolResult["content"] = [];
    const previews = [];
    let total = 0;
    for (const frame of selected) {
      if (args.mode === "text") break;
      const size = args.thumbnail ? 320 : 1600;
      const preview = await sharp(bytes, { page: frame, pages: 1, limitInputPixels: 40_000_000 })
        .timeout({ seconds: 10 })
        .rotate()
        .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer({ resolveWithObject: true });
      signal.throwIfAborted();
      total += preview.data.length;
      if (total > 8 * 1024 * 1024)
        throw new DomainError("VALIDATION", "图片预览过大，请减少帧数或使用缩略图");
      previews.push({ frame, width: preview.info.width, height: preview.info.height });
      images.push({ type: "image", data: preview.data.toString("base64"), mimeType: "image/png" });
    }
    const delays = metadata.delay ?? [];
    const details = {
      ...source,
      mediaType: "image",
      format: metadata.format,
      width: metadata.width,
      height: metadata.pageHeight ?? metadata.height,
      previewWidth: previews[0]?.width,
      previewHeight: previews[0]?.height,
      frame: selected[0],
      frames: count,
      selectedFrames: selected,
      previews,
      animation: {
        animated: count > 1,
        frameDelayMs: delays.slice(0, 10000),
        delaysTruncated: delays.length > 10000,
        durationMs: delays.length ? delays.reduce((a, b) => a + b, 0) : null,
        loop: metadata.loop ?? null,
        playbackVerified: false,
      },
      capabilities: { text: false, pages: false, frames: true, thumbnail: true, download: true },
    };
    return {
      details,
      content: [
        ...result({
          ...details,
          note: "Selected still frames, orientation applied; animation playback is not verified.",
        }).content,
        ...images,
      ],
    };
  } catch (error) {
    if (signal.aborted || error instanceof DomainError) throw error;
    throw new DomainError("VALIDATION", "无法解码图片或图片超过预览限制");
  }
}
