import type { Node } from "./model.js";

/** Generation has no document-reading loop. Keep this eligibility rule shared
 * with the client; the server remains authoritative over the resolved context. */
export function generationPdfNodeIds(nodes: Iterable<Pick<Node, "id" | "kind">>) {
  return [...new Set([...nodes].filter((node) => node.kind === "pdf").map((node) => node.id))];
}
