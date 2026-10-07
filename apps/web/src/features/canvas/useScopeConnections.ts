import type { Edge, Node, Rect } from "@intrica/contracts";
import { useMemo } from "react";
import { RectMap } from "./rect-map";
import { projectScopeEdges } from "./scene";

export function useScopeConnections(
  nodes: ReadonlyMap<string, Node>,
  edges: ReadonlyMap<string, Edge>,
  committed: ReadonlyMap<string, Rect>,
  preview: ReadonlyMap<string, Rect>,
  external = false,
) {
  const topology = useMemo(() => {
    const projection = projectScopeEdges(nodes, edges, committed, external);
    const owners = new Map([...committed].map(([id, rect]) => [rect, id]));
    const anchors = new Map([...projection.rects].map(([id, rect]) => [id, owners.get(rect)]));
    return { ...projection, anchors };
  }, [nodes, edges, committed, external]);
  return useMemo(() => {
    let boundary: Rect | undefined;
    return {
      edges: topology.edges,
      rects: new RectMap(topology.rects, (id, _rect) => {
        const anchor = topology.anchors.get(id);
        if (anchor) return preview.get(anchor)!;
        if (!boundary) {
          let left = Infinity,
            top = Infinity,
            right = -Infinity,
            bottom = -Infinity;
          for (const r of preview.values()) {
            left = Math.min(left, r.x);
            top = Math.min(top, r.y);
            right = Math.max(right, r.x + r.width);
            bottom = Math.max(bottom, r.y + r.height);
          }
          boundary = {
            x: left - 16,
            y: top - 16,
            width: right - left + 32,
            height: bottom - top + 32,
          };
        }
        return boundary;
      }),
    };
  }, [topology, preview]);
}
