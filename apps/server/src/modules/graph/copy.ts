import type { Node } from "@intrica/contracts";
import { DomainError } from "../../adapters/postgres/database.js";
import type { GraphMutation } from "./mutation.js";
import type { GraphQueries } from "./queries.js";

export async function copyNodes(mutation: GraphMutation, queries: GraphQueries, nodeIds: string[]) {
  const selected = new Set(nodeIds);
  const roots: Node[] = [];
  for (const id of selected) {
    const node = await queries.node(id, mutation.tx);
    if (node.parentId === null || node.canvasId !== mutation.canvasId)
      throw new DomainError("SCOPE_MISMATCH", "请选择当前画布中的元素");
    let ancestor = node.parentId;
    let nested = false;
    while (ancestor !== mutation.canvasId) {
      if (selected.has(ancestor)) {
        nested = true;
        break;
      }
      const parent = await queries.node(ancestor, mutation.tx);
      ancestor = parent.parentId!;
    }
    if (!nested) roots.push(node);
  }
  const copy = async (node: Node, parentId: string, offset: number): Promise<string> => {
    const id = await mutation.insert({
      kind: node.kind,
      parentId,
      position: { ...node.position, x: node.position.x + offset, y: node.position.y + offset },
      ...(node.title !== undefined ? { title: node.title } : {}),
      ...(node.text !== undefined ? { text: node.text } : {}),
      ...(node.summary !== undefined ? { summary: node.summary } : {}),
      ...(node.agent ? { agent: { ...node.agent, enabled: false } } : {}),
      ...(node.todo ? { todo: node.todo } : {}),
      ...(node.resource ? { resource: node.resource } : {}),
      ...(node.assetId ? { assetId: node.assetId } : {}),
      ...(node.alt !== undefined ? { alt: node.alt } : {}),
    });
    for (const child of await queries.children(node.id, mutation.tx)) await copy(child, id, 0);
    return id;
  };
  const copies: string[] = [];
  for (const node of roots) copies.push(await copy(node, node.parentId!, 24));
  return { nodeIds: copies };
}
