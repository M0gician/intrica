import { schemas } from "@intrica/contracts";
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { board, k, key } from "./helpers/runtime-redesign.js";

it("validates real graph and generation projections against the public schemas", async () => {
  const create = (text: string) =>
    k.graph.createNode({
      kind: "text",
      parentId: board,
      text,
      position: { x: 10, y: 20, width: 240, height: 160 },
      idempotencyKey: key(),
    });
  const first = (await create("Original requirement")).node;
  const second = (await create("Connected evidence")).node;
  await k.graph.createLink({ fromId: first.id, toId: second.id, idempotencyKey: key() });
  for (const full of [false, true]) {
    const snapshot = await k.graph.queries.snapshot(board, full);
    for (const node of snapshot.nodes)
      expect([...Value.Errors(schemas.NodeSchema, node)], `node ${node.id}`).toEqual([]);
    for (const edge of snapshot.edges) expect(Value.Check(schemas.EdgeSchema, edge)).toBe(true);
  }
  const { preview } = await k.generation.preview({
    type: "expand",
    scopeId: board,
    selection: [first.id],
    includeDescendants: [],
    includeConnected: true,
    instruction: "Use the evidence",
  });
  expect(Value.Check(schemas.ContextSnapshotSchema, preview.draft)).toBe(true);
  expect(preview.draft.edges.length).toBeGreaterThan(0);
  expect(Value.Check(schemas.ContextSnapshotSchema, { ...preview.draft, snapshotVersion: 1 })).toBe(
    false,
  );
  expect(
    Value.Check(schemas.ContextSnapshotSchema, {
      ...preview.draft,
      edges: preview.draft.edges.map((edge) => ({ ...edge, confirmed: false })),
    }),
  ).toBe(false);
});
