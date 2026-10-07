import type { ContextSnapshot } from "@intrica/contracts";
import { describe, expect, it } from "vitest";
import { MockRunner } from "./mock.js";
import type { FrozenOperation, ModelEvent } from "./types.js";

function makeSnapshot(selection: string[], titles: Record<string, string>): ContextSnapshot {
  return {
    snapshotVersion: 1,
    scope: { id: "root", kind: "group", title: "根", summary: "" },
    selection,
    contextOnlyNodeIds: [],
    nodes: selection.map((id) => ({
      id,
      kind: "text" as const,
      title: titles[id] ?? id,
      text: `${id} 正文`,
      revision: 1,
      containerPath: ["root"],
    })),
    edges: [],
    includeDescendants: [],
    omittedNodeIds: [],
    instruction: "",
  };
}

function makeOp(overrides: Partial<FrozenOperation> = {}): FrozenOperation {
  return {
    operationId: "op-test",
    type: "expand",
    contextSnapshot: makeSnapshot(["n-1"], { "n-1": "假设" }),
    placementMode: "sibling",
    instruction: "提出一个可验证的下一步假设",
    ...overrides,
  };
}

async function collect(
  runner: MockRunner,
  op: FrozenOperation,
  signal?: AbortSignal,
): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  const gen = runner.run(op, signal ?? new AbortController().signal);
  for await (const e of gen) events.push(e);
  return events;
}

describe("MockRunner", () => {
  it("expand yields two deterministic items with three segments each", async () => {
    const runner = new MockRunner({ streamDelayMs: 0, supportsVision: true });
    const events = await collect(runner, makeOp());
    expect(events.map((e) => e.type)).toEqual([
      "item.start",
      "item.segment",
      "item.segment",
      "item.segment",
      "item.complete",
      "item.start",
      "item.segment",
      "item.segment",
      "item.segment",
      "item.complete",
    ]);
    const starts = events.filter((e) => e.type === "item.start");
    expect(starts[0]).toMatchObject({ itemIndex: 0, title: "可验证假设：假设" });
    expect(starts[1]).toMatchObject({ itemIndex: 1, title: "替代解释：假设" });
    const segments = events.filter((e) => e.type === "item.segment");
    expect(segments.some((e) => e.type === "item.segment" && e.text.includes("假设"))).toBe(true);
    expect(
      segments.some(
        (e) => e.type === "item.segment" && e.text.includes("提出一个可验证的下一步假设"),
      ),
    ).toBe(true);
    const again = await collect(runner, makeOp());
    expect(again).toEqual(events);
  });

  it("deepen yields two deterministic items", async () => {
    const runner = new MockRunner({ streamDelayMs: 0, supportsVision: true });
    const events = await collect(
      runner,
      makeOp({ type: "deepen", placementMode: "inside_selected" }),
    );
    const starts = events.filter((e) => e.type === "item.start");
    expect(starts[0]).toMatchObject({ itemIndex: 0, title: "深入问题：假设" });
    expect(starts[1]).toMatchObject({ itemIndex: 1, title: "细节推演：假设" });
    expect(events.filter((e) => e.type === "item.complete").length).toBe(2);
  });

  it("compress yields exactly one title segment then summary segments", async () => {
    const runner = new MockRunner({ streamDelayMs: 0, supportsVision: true });
    const events = await collect(
      runner,
      makeOp({
        type: "compress",
        placementMode: "compress_container",
        contextSnapshot: makeSnapshot(["n-1", "n-2"], { "n-1": "假设", "n-2": "竞品" }),
      }),
    );
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]).toMatchObject({
      type: "summary.segment",
      field: "title",
      segmentIndex: 0,
      text: "假设·摘要",
    });
    const summarySegments = events.filter(
      (e) => e.type === "summary.segment" && e.field === "summary",
    );
    expect(summarySegments.length).toBeGreaterThanOrEqual(1);
    expect(
      summarySegments.some(
        (e) => e.type === "summary.segment" && e.text.includes("假设") && e.text.includes("竞品"),
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === "item.start")).toBe(false);
  });

  it("stops quietly when the signal aborts mid-stream", async () => {
    const runner = new MockRunner({ streamDelayMs: 5, supportsVision: true });
    const controller = new AbortController();
    const events: ModelEvent[] = [];
    for await (const e of runner.run(makeOp(), controller.signal)) {
      events.push(e);
      if (events.length === 2) controller.abort();
    }
    expect(events.length).toBeLessThan(10);
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it("returns immediately when the signal is already aborted", async () => {
    const runner = new MockRunner({ streamDelayMs: 0, supportsVision: true });
    const controller = new AbortController();
    controller.abort();
    const events = await collect(runner, makeOp(), controller.signal);
    expect(events).toEqual([]);
  });
});
