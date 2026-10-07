import type { Node } from "./model.js";

/** Management follows direct Agent parentage; ordinary containers stop the chain. */
export function agentAncestors(nodes: readonly Node[], id: string): Node[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const found: Node[] = [];
  const seen = new Set([id]);
  let current = byId.get(id);
  while (current?.kind === "agent" && current.parentId && !seen.has(current.parentId)) {
    const parent = byId.get(current.parentId);
    if (parent?.kind !== "agent") break;
    seen.add(parent.id);
    found.push(parent);
    current = parent;
  }
  return found;
}
export function managesNode(nodes: readonly Node[], manager: string, target: string): boolean {
  return manager !== target && agentAncestors(nodes, target).some((n) => n.id === manager);
}
