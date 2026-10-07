import { schemas } from "@intrica/contracts";
import { fixtureEdges, fixtureNodes, prdExampleContextSnapshot } from "@intrica/tests-fixtures";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

describe("PRD §5 示例快照的 schema 校验", () => {
  it("示例 contextSnapshot 通过 ContextSnapshotSchema", () => {
    expect(Value.Check(schemas.ContextSnapshotSchema, prdExampleContextSnapshot)).toBe(true);
  });

  it("ContextSnapshotSchema 拒绝错误的 snapshotVersion", () => {
    expect(
      Value.Check(schemas.ContextSnapshotSchema, {
        ...prdExampleContextSnapshot,
        snapshotVersion: 1,
      }),
    ).toBe(false);
  });

  it("ContextSnapshotSchema 拒绝未确认的边（confirmed 必须为 true）", () => {
    const [edge, ...rest] = prdExampleContextSnapshot.edges;
    expect(
      Value.Check(schemas.ContextSnapshotSchema, {
        ...prdExampleContextSnapshot,
        edges: [{ ...edge, confirmed: false }, ...rest],
      }),
    ).toBe(false);
  });
});

describe("固定图 fixtures 的 schema 校验", () => {
  it("fixtureNodes 每个节点通过 NodeSchema", () => {
    expect(fixtureNodes.length).toBeGreaterThan(0);
    for (const node of fixtureNodes) {
      expect(Value.Check(schemas.NodeSchema, node), `NodeSchema 拒绝 ${node.id}`).toBe(true);
    }
  });

  it("fixtureEdges 每条边通过 EdgeSchema", () => {
    expect(fixtureEdges.length).toBeGreaterThan(0);
    for (const edge of fixtureEdges) {
      expect(Value.Check(schemas.EdgeSchema, edge), `EdgeSchema 拒绝 ${edge.id}`).toBe(true);
    }
  });
});
