import type { Edge, Node, Rect } from "@intrica/contracts";
import { ROOT_NODE_ID } from "@intrica/contracts";
import { tr } from "../i18n";
import type { GraphState } from "../state/types";
/** 判断 ancestorId 是否为 nodeId 的祖先（含自身）。 */
export function isSelfOrAncestor(
  nodes: ReadonlyMap<string, Node>,
  ancestorId: string,
  nodeId: string,
): boolean {
  let current: string | null = nodeId;
  const seen = new Set<string>();
  while (current !== null && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = nodes.get(current)?.parentId ?? null;
  }
  return false;
}
/** 选区是否同时包含某节点及其后代。返回冲突对或 null。 */
export function findAncestorConflict(
  nodes: ReadonlyMap<string, Node>,
  selection: ReadonlySet<string>,
): {
  ancestorId: string;
  descendantId: string;
} | null {
  for (const descendantId of selection) {
    const seen = new Set<string>();
    let ancestorId = nodes.get(descendantId)?.parentId;
    while (ancestorId && !seen.has(ancestorId)) {
      if (selection.has(ancestorId)) return { ancestorId, descendantId };
      seen.add(ancestorId);
      ancestorId = nodes.get(ancestorId)?.parentId;
    }
  }
  return null;
}
/** 选区的共同持久化父作用域；跨层返回 null。 */
export function commonScopeId(
  nodes: ReadonlyMap<string, Node>,
  selection: ReadonlySet<string>,
): string | null {
  let scope: string | null | undefined;
  for (const id of selection) {
    const parentId = nodes.get(id)?.parentId ?? null;
    if (scope === undefined) scope = parentId;
    else if (scope !== parentId) return null;
  }
  return scope === undefined ? null : scope;
}
/** 节点的祖先链（含自身），根在前。 */
export function ancestorPath(nodes: ReadonlyMap<string, Node>, nodeId: string): Node[] {
  const path: Node[] = [];
  let current: string | null = nodeId;
  const seen = new Set<string>();
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const node: Node | undefined = nodes.get(current);
    if (!node) break;
    path.unshift(node);
    current = node.parentId;
  }
  return path;
}
export type ColorTier = "latest" | "history" | "user";
/** 颜色等级：origin=model 且 createdAt 等于最近一批次 → 最近生成；更早的模型产物 → 历史。 */
export function colorTierOf(node: Node, latestModelBatchAt: string | null): ColorTier {
  if (node.origin !== "model") return "user";
  if (latestModelBatchAt !== null && node.createdAt === latestModelBatchAt) return "latest";
  return "history";
}
/** 跨作用域连接：恰好一端在 visibleIds 中的已提交关系。 */
export function crossScopeEdgesFor(
  edges: Iterable<Edge>,
  nodeId: string,
  visibleIds: ReadonlySet<string>,
): Edge[] {
  const result: Edge[] = [];
  for (const edge of edges) {
    if (edge.from !== nodeId && edge.to !== nodeId) continue;
    const otherId = edge.from === nodeId ? edge.to : edge.from;
    if (!visibleIds.has(otherId)) result.push(edge);
  }
  return result;
}
export function edgeOtherNodeId(edge: Edge, nodeId: string): string {
  return edge.from === nodeId ? edge.to : edge.from;
}
export function nodeDisplayTitle(node: Pick<Node, "title" | "kind" | "id">): string {
  if (node.title && node.title.length > 0) return node.title;
  if (node.kind === "image") return tr("未命名图片");
  if (node.kind === "pdf") return tr("未命名 PDF");
  if (node.kind === "group") return tr("未命名容器");
  if (node.kind === "agent") return tr("未命名 Agent");
  if (node.kind === "todo") return tr("未命名待办");
  return tr("未命名文字");
}
/** 收集当前视图可见的已提交节点：基础作用域子节点 + 覆盖空间子节点。 */
export function visibleCommittedNodes(
  graph: GraphState,
  baseScopeId: string,
  overlayContainerId: string | null,
) {
  const base: Node[] = [];
  const overlay: Node[] = [];
  for (const node of graph.nodes.values()) {
    if (node.id === ROOT_NODE_ID) continue;
    if (node.parentId === baseScopeId) {
      base.push(node);
    } else if (overlayContainerId !== null && node.parentId === overlayContainerId) {
      overlay.push(node);
    }
  }
  return { base, overlay };
}
export function childImageThumbnails(graph: GraphState, node: Node, limit = 3): Node[] {
  const result: Node[] = [];
  for (const childId of node.childOrder) {
    const child = graph.nodes.get(childId);
    if ((child?.kind === "image" || child?.kind === "pdf") && child.assetId) {
      result.push(child);
      if (result.length >= limit) break;
    }
  }
  return result;
}
export function worldRectOf(node: Node): Rect {
  return node.position;
}
/** 收集根列表及其全部后代（子树），根在前、深度优先。 */
export function collectSubtreeIds(nodes: ReadonlyMap<string, Node>, rootIds: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = nodes.get(id);
    if (!node) return;
    result.push(id);
    for (const childId of node.childOrder) walk(childId);
  };
  for (const id of rootIds) walk(id);
  return result;
}
