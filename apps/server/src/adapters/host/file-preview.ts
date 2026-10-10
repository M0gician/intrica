import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname } from "node:path";
import { type FileContent, MAX_IMAGE_PIXELS } from "@intrica/contracts";
import sharp from "sharp";
import { DomainError } from "../postgres/database.js";

export const MAX_MEDIA_PREVIEW = 20 * 1024 * 1024;
export const MAX_TEXT_PREVIEW = 1024 * 1024;
export function sniffMime(data: Buffer, name: string, partial = false): string {
  if (data.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6))) return "image/gif";
  if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  const header = data.subarray(0, 8192).toString("utf8").trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(header))
    return "image/svg+xml";
  if (
    /^(?:<!doctype html[^>]*>\s*)?<(?:html|div|p|h[1-6]|article|section|table)(?:\s|>)/i.test(
      header,
    )
  )
    return "text/html";
  if (data.includes(0)) return "application/octet-stream";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data, { stream: partial });
  } catch {
    return "application/octet-stream";
  }
  return [".md", ".markdown"].includes(extname(name).toLowerCase())
    ? "text/markdown"
    : "text/plain";
}

export async function previewBytes(data: Buffer, name: string, path = ""): Promise<FileContent> {
  const mime = sniffMime(data, name);
  const file: FileContent = { name, path, mime, size: data.length };
  if (mime === "application/pdf") return file;
  if (mime.startsWith("image/")) {
    if (data.length > MAX_MEDIA_PREVIEW) return { ...file, previewError: "too_large" };
    try {
      await sharp(data, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
      return { ...file, data: data.toString("base64") };
    } catch {
      return { ...file, previewError: "corrupt" };
    }
  }
  if (mime === "application/octet-stream") return { ...file, previewError: "unsupported" };
  if (data.length > MAX_TEXT_PREVIEW) return { ...file, previewError: "too_large" };
  return { ...file, text: new TextDecoder("utf-8", { fatal: true }).decode(data) };
}

export async function readFilePreview(path: string, name = basename(path)): Promise<FileContent> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new DomainError("VALIDATION", "只能预览普通文件");
    if (before.size > MAX_MEDIA_PREVIEW) {
      const header = Buffer.alloc(8192);
      const read = await handle.read(header, 0, header.length, 0);
      return {
        name,
        path,
        size: before.size,
        mime: sniffMime(header.subarray(0, read.bytesRead), name, true),
        previewError: "too_large",
      };
    }
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      count !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new DomainError("TARGET_CHANGED", "文件在预览期间发生变化，请重新打开");
    return previewBytes(bytes.subarray(0, count), name, path);
  } finally {
    await handle.close();
  }
}
