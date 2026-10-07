import type { CandidateNodeProjection } from "@intrica/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeOperation } from "../../test/factories";
import { ReviewPanel } from "../ReviewPanel";

const candidate: CandidateNodeProjection = {
  id: "cand-1",
  kind: "text",
  parentId: "root",
  position: { x: 0, y: 0, width: 240, height: 160 },
  lifecycle: "candidate",
  operationId: "op-1",
  origin: "model",
  title: "候选甲",
  text: "# 候选内容\n- 要点",
};

function renderPanel(overrides: Partial<Parameters<typeof ReviewPanel>[0]> = {}) {
  const props: Parameters<typeof ReviewPanel>[0] = {
    operation: makeOperation({ id: "op-1", status: "candidate", selection: ["a"] }),
    candidates: [candidate],
    candidateContainer: null,
    inputTitles: ["证据甲"],
    memberTitles: ["证据甲"],
    onClose: vi.fn(),
    onAcceptAll: vi.fn(),
    onDiscard: vi.fn(),
    onRetry: vi.fn(),
    onUndo: vi.fn(),
    onPreviewInside: vi.fn(),
    ...overrides,
  };
  render(<ReviewPanel {...props} />);
  return props;
}

describe("ReviewPanel", () => {
  it("候选内容只读全文（Markdown-lite 渲染）与放置信息", () => {
    renderPanel();
    expect(screen.getByRole("heading", { level: 1, name: "候选内容" })).toBeTruthy();
    expect(screen.getByText("当前层（与选中节点同级）")).toBeTruthy();
    expect(screen.getByText("扩展 · 未提交")).toBeTruthy();
  });

  it("未提交：接受全部 / 丢弃 / 重试 / 查看候选内部", () => {
    const props = renderPanel({
      operation: makeOperation({
        id: "op-2",
        type: "deepen",
        status: "candidate",
        selection: ["a"],
      }),
    });
    screen.getByRole("button", { name: "接受全部" }).click();
    expect(props.onAcceptAll).toHaveBeenCalledWith("op-2");
    screen.getByRole("button", { name: "丢弃" }).click();
    expect(props.onDiscard).toHaveBeenCalledWith("op-2");
    screen.getByRole("button", { name: "重试" }).click();
    expect(props.onRetry).toHaveBeenCalledWith("op-2");
    screen.getByRole("button", { name: "查看候选内部" }).click();
    expect(props.onPreviewInside).toHaveBeenCalledWith("op-2");
  });

  it("收束候选：摘要与将移入成员", () => {
    renderPanel({
      operation: makeOperation({
        id: "op-3",
        type: "compress",
        status: "candidate",
        selection: ["a", "b"],
        candidateSummary: { title: "研究方向", summary: "候选摘要正文" },
      }),
      memberTitles: ["证据甲", "证据乙"],
    });
    expect(screen.getByRole("heading", { name: "研究方向" })).toBeTruthy();
    expect(screen.getByText("候选摘要正文")).toBeTruthy();
    expect(screen.getByText("将移入成员：证据甲、证据乙")).toBeTruthy();
  });

  it("committed 且未 undone：显示撤销", () => {
    const props = renderPanel({
      operation: makeOperation({
        id: "op-4",
        status: "committed",
        undoToken: "u-1",
        undone: false,
      }),
      candidates: [],
    });
    screen.getByRole("button", { name: "撤销" }).click();
    expect(props.onUndo).toHaveBeenCalledWith("op-4");
  });

  it("committed 且已 undone：不显示撤销", () => {
    renderPanel({
      operation: makeOperation({ id: "op-5", status: "committed", undoToken: "u-2", undone: true }),
      candidates: [],
    });
    expect(screen.queryByRole("button", { name: "撤销" })).toBeNull();
  });

  it("失败：显示原因与重试", () => {
    const props = renderPanel({
      operation: makeOperation({ id: "op-6", status: "failed", reason: "模型输出缺少必填字段" }),
      candidates: [],
    });
    expect(screen.getByText("原因：模型输出缺少必填字段")).toBeTruthy();
    screen.getByRole("button", { name: "重试" }).click();
    expect(props.onRetry).toHaveBeenCalledWith("op-6");
  });
});
