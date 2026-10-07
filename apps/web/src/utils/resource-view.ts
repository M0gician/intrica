import type { Node } from "@intrica/contracts";
import { todoHeight } from "@intrica/contracts";
import { tr } from "../i18n";
import { bookmarkUrl } from "./web-url";
export type ResourceTarget =
  | {
      type: "directory";
      path: string;
      nodeId: string;
      nonce: string;
    }
  | {
      type: "web";
      url: string;
      nodeId: string;
      nonce: string;
    };
/** A bookmark is a whole URL (optionally with a short title), never an arbitrary link in prose. */
export function nodeBookmark(node: Node) {
  if (node.kind !== "text" || node.resource) return null;
  const text = (node.text ?? "").trim();
  const markdown = text.match(/^\[([^\]\n]{1,160})\]\((https?:\/\/[^\s]+)\)$/);
  const lines = text.split(/\r?\n/).map((s) => s.trim());
  if (!markdown && (lines.length > 2 || (lines.length === 2 && lines[0]!.length > 160)))
    return null;
  const address = markdown?.[2] ?? lines.at(-1) ?? "";
  const url = bookmarkUrl(address);
  if (!url || (!markdown && lines.length === 2 && bookmarkUrl(lines[0]!))) return null;
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./, "");
  const label = markdown?.[1] ?? (lines.length === 2 ? lines[0] : undefined);
  const title =
    node.title && ![tr("网页链接"), tr("新文本"), tr("摘录"), url].includes(node.title)
      ? node.title
      : (label ?? host);
  return { url, host, title, path: parsed.pathname === "/" ? "" : parsed.pathname };
}
export type NodePresentation =
  | { type: Node["kind"] }
  | { type: "web"; bookmark: NonNullable<ReturnType<typeof nodeBookmark>> }
  | { type: "directory" | "file" | "path-image" | "path-pdf"; path: string };

export function nodePresentation(node: Node): NodePresentation {
  if (node.kind !== "text") return { type: node.kind };
  if (node.resource?.type === "directory") return { type: "directory", path: node.resource.path };
  if (node.resource?.type === "file") {
    const path = node.resource.path;
    if (/\.pdf$/i.test(path)) return { type: "path-pdf", path };
    if (/\.(?:gif|jpe?g|png|svg|webp)$/i.test(path)) return { type: "path-image", path };
    return { type: "file", path };
  }
  const bookmark = nodeBookmark(node);
  return bookmark ? { type: "web", bookmark } : { type: "text" };
}
/** View geometry uses compact resource cards and measured ToDo height. Server coordinates stay intact. */
export function presentNode(
  node: Node,
  heights: ReadonlyMap<string, number>,
  nodes: readonly Node[] | number = [],
): Node {
  const members =
    node.kind === "agent"
      ? typeof nodes === "number"
        ? nodes
        : nodes.filter((n) => n.kind === "agent" && n.parentId === node.id).length
      : 0;
  const extraWidth = members ? Math.ceil(Math.min(9, members) / 3) * 68 + 13 : 0;
  return {
    ...node,
    position: {
      ...node.position,
      width: node.position.width + extraWidth,
      height: nodeVisualHeight(node, heights),
    },
  };
}
export function nodeVisualHeight(node: Node, heights: ReadonlyMap<string, number>): number {
  const presentation = nodePresentation(node);
  if (presentation.type === "todo")
    return (
      heights.get(node.id) ??
      todoHeight(node.title ?? tr("待办"), node.text ?? "", node.position.width)
    );
  if (["directory", "web", "path-image"].includes(presentation.type)) return 180;
  return node.position.height;
}
