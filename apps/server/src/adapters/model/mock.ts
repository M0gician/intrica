import type { SnapshotNode } from "@intrica/contracts";
import type { FrozenOperation, ModelEvent, ModelRunner } from "./types.js";

type MockOptions = { streamDelayMs: number; supportsVision: boolean };

type PlannedItem = { title: string; segments: string[] };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstTitle(op: FrozenOperation): string {
  const firstId = op.contextSnapshot.selection[0];
  const first = op.contextSnapshot.nodes.find((n) => n.id === firstId);
  return first?.title ?? first?.id ?? "未命名节点";
}

function selectionTitles(op: FrozenOperation): string {
  const inSelection = new Set(op.contextSnapshot.selection);
  const titles = op.contextSnapshot.nodes
    .filter((n) => inSelection.has(n.id))
    .map((n: SnapshotNode) => n.title ?? n.id);
  return titles.join("、") || "选区";
}

function instructionLine(op: FrozenOperation): string {
  return op.instruction.length > 0 ? `补充要求：${op.instruction}。` : "未提供补充要求。";
}

function planItems(op: FrozenOperation): PlannedItem[] {
  const base = firstTitle(op);
  const titles = selectionTitles(op);
  if (op.type === "expand") {
    return [
      {
        title: `可验证假设：${base}`,
        segments: [
          `围绕「${titles}」提出一条可验证假设。`,
          instructionLine(op),
          "建议用最小实验在下一步验证该假设。",
        ],
      },
      {
        title: `替代解释：${base}`,
        segments: [
          `围绕「${titles}」给出一种替代解释。`,
          instructionLine(op),
          "对比两种解释的支持证据后再做取舍。",
        ],
      },
    ];
  }
  return [
    {
      title: `深入问题：${base}`,
      segments: [
        `针对「${titles}」追问一个更深入的问题。`,
        instructionLine(op),
        "回答该问题需要先澄清前提条件。",
      ],
    },
    {
      title: `细节推演：${base}`,
      segments: [
        `针对「${titles}」推演一层实现细节。`,
        instructionLine(op),
        "推演结论可作为后续展开的输入。",
      ],
    },
  ];
}

function planCompress(op: FrozenOperation): { title: string; segments: string[] } {
  const scope = op.contextSnapshot.scope;
  const scopeTitle = scope.id !== "root" && scope.title ? scope.title : firstTitle(op);
  const memberTitles = selectionTitles(op);
  return {
    title: `${scopeTitle}·摘要`,
    segments: [
      `本摘要覆盖 ${op.contextSnapshot.selection.length} 个成员节点：${memberTitles}。`,
      instructionLine(op),
    ],
  };
}

export class MockRunner implements ModelRunner {
  readonly supportsVision: boolean;
  private readonly streamDelayMs: number;

  constructor(options: MockOptions) {
    this.streamDelayMs = options.streamDelayMs;
    this.supportsVision = options.supportsVision;
  }

  async *run(op: FrozenOperation, signal: AbortSignal): AsyncGenerator<ModelEvent> {
    const pause = async (): Promise<boolean> => {
      if (signal.aborted) return false;
      if (this.streamDelayMs > 0) await sleep(this.streamDelayMs);
      return !signal.aborted;
    };
    if (op.type === "compress") {
      const plan = planCompress(op);
      if (!(await pause())) return;
      yield { type: "summary.segment", field: "title", segmentIndex: 0, text: plan.title };
      for (const [index, text] of plan.segments.entries()) {
        if (!(await pause())) return;
        yield { type: "summary.segment", field: "summary", segmentIndex: index, text };
      }
      return;
    }
    const items = planItems(op);
    for (const [itemIndex, item] of items.entries()) {
      if (!(await pause())) return;
      yield { type: "item.start", itemIndex, title: item.title };
      for (const text of item.segments) {
        if (!(await pause())) return;
        yield { type: "item.segment", itemIndex, text };
      }
      if (!(await pause())) return;
      yield { type: "item.complete", itemIndex };
    }
  }
}
