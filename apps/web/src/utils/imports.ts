import { newId } from "@intrica/client";
import type { FileContent, WorkspaceEntry } from "../api/workspace";
import { tr } from "../i18n";
import { safeWebUrl } from "./web-url";
export type ImportEntry = {
  id: string;
  name: string;
  file?: File;
  resource?: import("@intrica/contracts").LocalResource;
};
export const LOCAL_RESOURCE_MIME = "application/x-intrica-local-resource";
export const MAX_IMPORT_ENTRIES = 100;
const entry = (name: string): ImportEntry => ({ id: newId(), name });
export function isPdfFile(file: Pick<File, "type" | "name">): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}
export function filesToEntries(files: File[]): ImportEntry[] {
  if (files.length > MAX_IMPORT_ENTRIES) throw new Error(tr("每批最多导入 100 个文件"));
  if (files.some((file) => file.webkitRelativePath))
    throw new Error(tr("请从本机目录树添加目录，目录会作为一个对象保存"));
  return files.map((file) => ({ ...entry(file.name), file }));
}
export async function droppedEntries(data: DataTransfer): Promise<ImportEntry[]> {
  const items = Array.from(data.items ?? []).filter((item) => item.kind === "file");
  if (items.some((item) => item.webkitGetAsEntry?.()?.isDirectory))
    throw new Error(tr("请从本机目录树添加目录，目录会作为一个对象保存"));
  return filesToEntries(Array.from(data.files ?? []));
}
export function droppedText(data: DataTransfer): {
  text: string;
  title: string;
  imageUrl?: string;
} | null {
  const html = new DOMParser().parseFromString(data.getData("text/html"), "text/html");
  const img = html.querySelector("img");
  const imageUrl = safeWebUrl(img?.getAttribute("src") ?? "");
  const url = data
    .getData("text/uri-list")
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("#"))
    .map(safeWebUrl)
    .find(Boolean);
  const text = data.getData("text/plain").trim() || html.body.textContent?.trim() || url;
  const anchor =
    html.body.children.length === 1 && html.body.firstElementChild?.tagName === "A"
      ? html.body.firstElementChild
      : null;
  const anchorUrl = safeWebUrl(anchor?.getAttribute("href") ?? "");
  if (!imageUrl && text && anchorUrl && anchor?.textContent?.trim() === text)
    return { title: text.slice(0, 500), text: anchorUrl };
  if (imageUrl)
    return {
      imageUrl,
      title: img?.getAttribute("alt") || tr("网页图片"),
      text: imageUrl,
    };
  return text
    ? {
        title: url ? tr("网页链接") : tr("摘录"),
        text:
          url && !text.includes(url) ? tr("{{v0}}\n\n来源：{{v1}}", { v0: text, v1: url }) : text,
      }
    : null;
}
export async function readTextFile(file: File): Promise<string> {
  if (file.size > 1024 * 1024) throw new Error(tr("{{v0}} 超过 1 MB 文本上限", { v0: file.name }));
  if (file.type && !file.type.startsWith("text/") && !/json|javascript|xml|yaml/.test(file.type))
    throw new Error(tr("暂不支持文件类型：{{v0}}", { v0: file.name }));
  const bytes = await file.arrayBuffer();
  if (new Uint8Array(bytes).includes(0))
    throw new Error(tr("无法作为文本读取：{{v0}}", { v0: file.name }));
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(tr("请将 {{v0}} 转为 UTF-8 文本", { v0: file.name }));
  }
  if (text.length > 50000)
    throw new Error(
      tr("{{v0}} 超过 50,000 字符的节点正文上限", {
        v0: file.name,
      }),
    );
  return text;
}
export async function localImportEntry(
  item: WorkspaceEntry,
  serverRequest: import("../api/connection").SessionConnection["serverRequest"],
): Promise<ImportEntry> {
  if (item.type === "directory" || /\.pdf$/i.test(item.path))
    return {
      id: newId(),
      name: item.name,
      resource: { type: item.type, path: item.path },
    };
  const content = await serverRequest<FileContent>(`file?path=${encodeURIComponent(item.path)}`);
  const bytes = content.data
    ? Uint8Array.from(atob(content.data), (char) => char.charCodeAt(0))
    : (content.text ?? "");
  return {
    id: newId(),
    name: content.name,
    file: new File([bytes], content.name, { type: content.mime }),
    resource: { type: "file", path: item.path },
  };
}
