import type { Edge, Node, Rect } from "@intrica/contracts";
import { presentNode } from "../../utils/resource-view";
/** The cache keeps card identity stable when an unrelated node or run changes. */
export class SceneProjection {
  private cache = new WeakMap<Node, { height: number | undefined; members: number; node: Node }>();
  project(nodes: ReadonlyMap<string, Node>, heights: ReadonlyMap<string, number>) {
    const teams = new Map<string, Node[]>();
    for (const node of nodes.values())
      if (node.kind === "agent" && node.parentId) {
        // Direct Agent children define both the container preview and its team.
        const members = teams.get(node.parentId) ?? [];
        members.push(node);
        teams.set(node.parentId, members);
      }
    const projected = new Map<string, Node>();
    for (const node of nodes.values()) {
      const height = heights.get(node.id),
        members = teams.get(node.id)?.length ?? 0;
      let value = this.cache.get(node);
      if (!value || value.height !== height || value.members !== members) {
        value = { height, members, node: presentNode(node, heights, members) };
        this.cache.set(node, value);
      }
      projected.set(node.id, value.node);
    }
    return { nodes: projected, teams };
  }
}
export function orderedChildren(nodes: ReadonlyMap<string, Node>, scopeId: string) {
  const result: Node[] = [],
    seen = new Set<string>();
  for (const id of nodes.get(scopeId)?.childOrder ?? []) {
    const node = nodes.get(id);
    if (node?.parentId === scopeId) {
      result.push(node);
      seen.add(id);
    }
  }
  for (const node of nodes.values())
    if (node.parentId === scopeId && !seen.has(node.id)) result.push(node);
  return result;
}
export function crossScopeCounts(
  nodes: ReadonlyMap<string, Node>,
  edges: ReadonlyMap<string, Edge>,
) {
  const counts = new Map<string, number>();
  for (const edge of edges.values())
    if (nodes.get(edge.from)?.parentId !== nodes.get(edge.to)?.parentId)
      for (const id of [edge.from, edge.to]) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

/** Drawing-only endpoint projection. Real edge IDs/endpoints remain the action targets. */
export function projectScopeEdges(
  nodes: ReadonlyMap<string, Node>,
  edges: ReadonlyMap<string, Edge>,
  visible: ReadonlyMap<string, Rect>,
  showExternal = false,
) {
  const rects = new Map(visible),
    result: Edge[] = [];
  const anchor = (id: string) => {
    const seen = new Set<string>();
    while (!seen.has(id)) {
      if (visible.has(id)) return id;
      seen.add(id);
      const parent = nodes.get(id)?.parentId;
      if (!parent) return null;
      id = parent;
    }
    return null;
  };
  const values = [...visible.values()];
  const left = Math.min(...values.map((r) => r.x)) - 16,
    top = Math.min(...values.map((r) => r.y)) - 16;
  const boundary = {
    x: left,
    y: top,
    width: Math.max(...values.map((r) => r.x + r.width)) - left + 16,
    height: Math.max(...values.map((r) => r.y + r.height)) - top + 16,
  };
  for (const edge of edges.values()) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    const from = anchor(edge.from),
      to = anchor(edge.to);
    if (from === to || (!showExternal && (!from || !to))) continue;
    if (!from && !to) continue;
    rects.set(edge.from, from ? visible.get(from)! : boundary);
    rects.set(edge.to, to ? visible.get(to)! : boundary);
    result.push(edge);
  }
  return { edges: result, rects };
}
