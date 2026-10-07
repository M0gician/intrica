import type { Edge, Node } from "./model.js";

export const GRAPH_PROTOCOL = 1;

export type GraphDelta = {
  canvasId: string;
  kind: string;
  graphRevision: number;
  command: { id: string; requestId: string } | null;
  modelBatch: { operationId: string; committedAt: string } | null;
  nodes: Node[];
  deletedNodeIds: string[];
  edges: Edge[];
  deletedEdgeIds: string[];
};

/** The HTTP receipt and canvas event carry the same committed change. */
export type GraphMutationResponse = {
  graphOpId: string;
  graphRevision: number;
  canvasSeq: string;
  affectedNodeIds: string[];
  delta: GraphDelta;
};

export type CanvasCommandResponse = {
  graphOpId: string;
  graphRevision: number;
  affectedNodeIds: string[];
};
