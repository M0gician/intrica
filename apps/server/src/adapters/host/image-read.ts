import { createHash } from "node:crypto";
import sharp from "sharp";
import { result, type ToolResult } from "../../modules/execution/tool-calls.js";
import { DomainError } from "../postgres/database.js";

/** Decode the exact authorized bytes, including immutable published snapshots. */
export async function readImageBytes(
  bytes: Buffer,
  args: { frame?: number; mode?: "auto" | "image" | "text" },
  signal: AbortSignal,
  supportsVision: boolean,
  origin: Record<string, unknown> = {},
): Promise<ToolResult> {
  signal.throwIfAborted();
  if (bytes.length > 20 * 1024 * 1024) throw new DomainError("VALIDATION", "图片必须小于 20 MiB");
  try {
    const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 })
      .timeout({ seconds: 10 })
      .metadata();
    if (!["png", "jpeg", "webp", "gif"].includes(metadata.format ?? ""))
      throw new DomainError("VALIDATION", "图片只支持 PNG、JPEG、WebP 和 GIF；其他媒体请先转换");
    const frames = metadata.pages ?? 1,
      frame = args.frame ?? 0;
    if (!Number.isInteger(frame) || frame < 0 || frame >= frames)
      throw new DomainError("VALIDATION", `图片共 ${frames} 帧，frame 从 0 开始`);
    const summary = {
      mediaType: "image",
      format: metadata.format,
      width: metadata.width,
      height: metadata.pageHeight ?? metadata.height,
      frame,
      frames,
      delays: metadata.delay ?? [],
      durationMs: (metadata.delay ?? []).reduce((a, b) => a + b, 0),
      loop: metadata.loop ?? null,
      hash: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
    if (args.mode === "text" || (!supportsVision && args.mode !== "image"))
      return result({ ...origin, ...summary });
    if (!supportsVision)
      throw new DomainError("VALIDATION", "当前模型不支持图像输入；使用 mode=text 查看媒体元数据");
    const preview = await sharp(bytes, { page: frame, pages: 1, limitInputPixels: 40_000_000 })
      .timeout({ seconds: 10 })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });
    signal.throwIfAborted();
    if (preview.data.length > 8 * 1024 * 1024)
      throw new DomainError("VALIDATION", "图片预览过大，请裁剪后重试");
    const details = {
      ...summary,
      mediaType: "image",
      format: metadata.format,
      width: metadata.width,
      height: metadata.pageHeight ?? metadata.height,
      previewWidth: preview.info.width,
      previewHeight: preview.info.height,
      frame,
      frames,
    };
    return {
      details,
      content: [
        ...result({
          ...origin,
          ...details,
          note: "Single still frame, orientation applied, resized to fit 1600px; animation playback is not verified.",
        }).content,
        { type: "image", data: preview.data.toString("base64"), mimeType: "image/png" },
      ],
    };
  } catch (error) {
    if (signal.aborted || error instanceof DomainError) throw error;
    throw new DomainError("VALIDATION", "无法解码图片或图片超过预览限制");
  }
}
