import type { SnapshotResponse } from "@intrica/contracts";
import { fixtureEdges, fixtureNodes } from "@intrica/tests-fixtures";
import { describe, expect, it } from "vitest";
import { reducer } from "../reducer";
import type { AppState } from "../types";
import { initialAppState } from "../types";

function makeSnapshot(overrides: Partial<SnapshotResponse> = {}): SnapshotResponse {
  return {
    activeCanvasId: "root",
    canvasSeq: "0",
    graphRevision: 42,
    nodes: fixtureNodes,
    edges: fixtureEdges,
    operations: [],
    candidateNodes: [],
    candidateContainers: [],
    latestModelBatchAt: null,
    latestModelBatchOperationId: null,
    ...overrides,
  };
}
describe("reducer：视图动作", () => {
  it("rebuilds both parents from child-only recruitment, move and deletion deltas", () => {
    let state = reducer(initialAppState(), { type: "snapshotLoaded", snapshot: makeSnapshot() });
    const child = {
      ...fixtureNodes[1]!,
      id: "recruited",
      parentId: "n-01",
      childOrder: [],
      sortKey: "1024",
    };
    const delta = (nodes: (typeof child)[], deletedNodeIds: string[] = []) => {
      state = reducer(state, {
        type: "graphDelta",
        delta: {
          canvasId: state.view.baseScopeId,
          kind: "node.update",
          command: null,
          modelBatch: null,
          graphRevision: state.graph.graphRevision + 1,
          nodes,
          deletedNodeIds,
          edges: [],
          deletedEdgeIds: [],
        },
      });
    };
    delta([child]);
    expect(state.graph.nodes.get("n-01")!.childOrder).toEqual([child.id]);
    delta([{ ...child, parentId: "n-02" }]);
    expect(state.graph.nodes.get("n-01")!.childOrder).toEqual([]);
    expect(state.graph.nodes.get("n-02")!.childOrder).toEqual([child.id]);
    delta([], [child.id]);
    expect(state.graph.nodes.get("n-02")!.childOrder).toEqual([]);
  });
  it("overlayOpened/displacementDropped/overlayClosed", () => {
    let state: AppState = initialAppState();
    state = reducer(state, {
      type: "overlayOpened",
      overlay: {
        containerId: "n-01",
        readonly: false,
        previewOperationId: null,
        bounds: { x: 100, y: 100, width: 400, height: 300 },
        displacement: new Map([
          ["n-02", { dx: 500, dy: 0 }],
          ["n-03", { dx: 0, dy: 400 }],
        ]),
      },
    });
    expect(state.view.overlaySpace?.displacement.size).toBe(2);

    state = reducer(state, { type: "displacementDropped", nodeIds: ["n-02"] });
    expect([...(state.view.overlaySpace?.displacement.keys() ?? [])]).toEqual(["n-03"]);

    state = reducer(state, { type: "overlayClosed" });
    expect(state.view.overlaySpace).toBeNull();
  });

  it("confirmed movement updates the parent and coordinates", () => {
    let state = reducer(initialAppState(), {
      type: "snapshotLoaded",
      snapshot: makeSnapshot(),
    });
    state = reducer(state, {
      type: "graphDelta",
      delta: {
        canvasId: state.view.baseScopeId,
        kind: "move",
        command: { id: "gop-move-1", requestId: "move-request" },
        modelBatch: null,
        graphRevision: 43,
        nodes: [
          {
            ...state.graph.nodes.get("n-01")!,
            parentId: "n-02",
            position: { x: 16, y: 16, width: 240, height: 160 },
            layoutVersion: 1,
          },
        ],
        deletedNodeIds: [],
        edges: [],
        deletedEdgeIds: [],
      },
    });
    const moved = state.graph.nodes.get("n-01");
    expect(moved?.parentId).toBe("n-02");
    expect(moved?.position.x).toBe(16);
    expect(state.graph.graphRevision).toBe(43);
  });
});
