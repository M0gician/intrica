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
export const excerptOf = (n: Node) =>
  (n.summary ?? n.text ?? n.alt ?? n.agent?.persona ?? "").replace(/\s+/g, " ").slice(0, 120);
export function canvasSummary(
  snapshot: SnapshotResponse,
  board: string | null,
  options: {
    query?: string;
    offset?: number;
    limit?: number;
    onlyConnected?: boolean;
    connected?: Set<string>;
  } = {},
) {
  const all = snapshot.nodes
    .filter((n) => n.parentId !== null && rootOf(snapshot, n.id) === board)
    .filter((n) => !options.onlyConnected || options.connected?.has(n.id))
    .filter(
      (n) =>
        !options.query ||
        `${n.id} ${n.title ?? ""} ${excerptOf(n)}`
          .toLocaleLowerCase()
          .includes(options.query.toLocaleLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(options.connected?.has(b.id) ?? false) -
          Number(options.connected?.has(a.id) ?? false) || a.id.localeCompare(b.id),
    );
  const offset = Math.max(0, options.offset ?? 0);
  const page = all.slice(offset, offset + Math.min(40, options.limit ?? 20));
  const ids = new Set(page.map((n) => n.id));
  const edges = snapshot.edges.filter(
    (e) =>
      (ids.has(e.from) || ids.has(e.to)) &&
      rootOf(snapshot, e.from) === board &&
      rootOf(snapshot, e.to) === board,
  );
  return {
    total: all.length,
    nextOffset: offset + page.length < all.length ? offset + page.length : null,
    nodes: page.map((n) => ({
      id: n.id,
      parentId: n.parentId,
      kind: n.kind,
      title: n.title,
      excerpt: excerptOf(n),
      ...(n.todo ? { completed: n.todo.completed } : {}),
      ...(n.childOrder.length ? { childCount: n.childOrder.length } : {}),
      ...(options.connected ? { connected: options.connected.has(n.id) } : {}),
    })),
    edges: edges.slice(0, 80).map(({ from, to, type }) => ({ from, to, type })),
    omittedEdges: Math.max(0, edges.length - 80),
  };
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
    ...(node.resource ? { resource: node.resource } : {}),
    ...(node.todo ? { todo: node.todo } : {}),
    ...(node.childOrder.length
      ? { childIds: node.childOrder.slice(0, 40), childCount: node.childOrder.length }
      : {}),
  };
}
