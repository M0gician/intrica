import { expect, it } from "vitest";
import { makeEdge, makeNode } from "../../test/factories";
import { projectScopeEdges } from "./scene";

it("projects a nested author's output to the visible container without changing the real edge", () => {
  const nodes = new Map(
    [
      makeNode({ id: "manager", kind: "agent" }),
      makeNode({ id: "worker", parentId: "manager", kind: "agent" }),
      makeNode({ id: "output" }),
    ].map((n) => [n.id, n]),
  );
  const edge = makeEdge({ id: "source", from: "output", to: "worker", type: "derived_from" });
  const edges = new Map([[edge.id, edge]]);
  const visible = new Map(["manager", "output"].map((id) => [id, nodes.get(id)!.position]));
  const projected = projectScopeEdges(nodes, edges, visible);
  expect(projected.edges).toEqual([edge]);
  expect(projected.edges[0]).toBe(edge);
  expect(projected.rects.get("worker")).toBe(visible.get("manager"));
  expect(visible.has("worker")).toBe(false);
  const inside = projectScopeEdges(
    nodes,
    edges,
    new Map([["worker", nodes.get("worker")!.position]]),
    true,
  );
  expect(inside.edges).toEqual([edge]);
  expect(inside.rects.get("output")!.width).toBeGreaterThan(nodes.get("worker")!.position.width);
  expect(edges.size).toBe(1);
});

it("does not draw collapsed internal, missing, or cyclic endpoints", () => {
  const a = makeNode({ id: "a", parentId: "b" }),
    b = makeNode({ id: "b", parentId: "a" });
  const nodes = new Map([
    [a.id, a],
    [b.id, b],
  ]);
  expect(
    projectScopeEdges(nodes, new Map([["e", makeEdge({ id: "e" })]]), new Map()).edges,
  ).toEqual([]);
});
