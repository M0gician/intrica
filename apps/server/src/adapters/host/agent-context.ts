import type { Node, SnapshotResponse } from "@intrica/contracts";

export function rootOf(snapshot: Pick<SnapshotResponse, "nodes">, id: string): string | null {
  const nodes = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  let node = nodes.get(id);
  while (node?.parentId) {
    if (seen.has(node.id)) return null;
    seen.add(node.id);
    node = nodes.get(node.parentId);
  }
  return node?.id ?? null;
}
export function nodeContent(node: Node, offset = 0, limit = 6000) {
  const field =
    node.kind === "group"
      ? "summary"
      : node.kind === "image"
        ? "alt"
        : node.kind === "agent"
          ? "persona"
          : "text";
  const content =
    field === "persona"
      ? (node.agent?.persona ?? "")
      : (node[field as "text" | "summary" | "alt"] ?? "");
  const start = Math.max(0, offset);
  const end = Math.min(content.length, start + Math.min(12000, limit));
  return {
    id: node.id,
    parentId: node.parentId,
    kind: node.kind,
    title: node.title,
    revision: node.revision,
    field,
    content: content.slice(start, end),
    totalChars: content.length,
    nextOffset: end < content.length ? end : null,
    ...(node.resource
      ? {
          resource: node.resource.snapshot
            ? {
                type: "file",
                sourcePath: node.resource.path,
                snapshot: node.resource.snapshot,
                note: "Read this node to inspect the immutable version. sourcePath is mutable and may now contain another version.",
              }
            : node.resource,
        }
      : {}),
    ...(node.todo ? { todo: node.todo } : {}),
    ...(node.childOrder.length
      ? { childIds: node.childOrder.slice(0, 40), childCount: node.childOrder.length }
      : {}),
  };
}
