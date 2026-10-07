import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeOperation } from "../../test/factories";
import { TaskBar, type TaskChipData } from "../TaskBar";

function chip(overrides: Partial<TaskChipData> = {}): TaskChipData {
  return {
    operation: makeOperation({ id: "op-1", status: "queued" }),
    queuePosition: null,
    segmentCount: 0,
    candidateCount: 0,
    ...overrides,
  };
}

function renderBar(chips: TaskChipData[]) {
  const props = {
    chips,
    onCancel: vi.fn(),
    onAcceptAll: vi.fn(),
    onReviewOne: vi.fn(),
    onDiscard: vi.fn(),
    onRetry: vi.fn(),
    onShowReason: vi.fn(),
    onUndo: vi.fn(),
    onClose: vi.fn(),
  };
  render(<TaskBar {...props} />);
  return props;
}

describe("TaskBar：各状态 chip", () => {
  it("排队中：位次与取消排队", () => {
    const props = renderBar([chip({ queuePosition: 2 })]);
    expect(screen.getByText("扩展 · 排队中")).toBeTruthy();
    expect(screen.getByText("第 2 位")).toBeTruthy();
    screen.getByRole("button", { name: "取消排队" }).click();
    expect(props.onCancel).toHaveBeenCalledWith("op-1");
  });

  it("生成中：进度与取消", () => {
    const props = renderBar([
      chip({ operation: makeOperation({ id: "op-2", status: "running" }), segmentCount: 3 }),
    ]);
    expect(screen.getByText("扩展 · 生成中")).toBeTruthy();
    expect(screen.getByText("已到达 3 段")).toBeTruthy();
    screen.getByRole("button", { name: "取消" }).click();
    expect(props.onCancel).toHaveBeenCalledWith("op-2");
  });

  it("未提交：接受全部 / 逐个查看 / 丢弃", () => {
    const props = renderBar([
      chip({ operation: makeOperation({ id: "op-3", status: "candidate" }), candidateCount: 2 }),
    ]);
    screen.getByRole("button", { name: "接受全部" }).click();
    expect(props.onAcceptAll).toHaveBeenCalledWith("op-3");
    screen.getByRole("button", { name: "逐个查看" }).click();
    expect(props.onReviewOne).toHaveBeenCalledWith("op-3");
    screen.getByRole("button", { name: "丢弃" }).click();
    expect(props.onDiscard).toHaveBeenCalledWith("op-3");
  });

  it("失败：重试与查看原因", () => {
    const props = renderBar([chip({ operation: makeOperation({ id: "op-4", status: "failed" }) })]);
    screen.getByRole("button", { name: "重试" }).click();
    expect(props.onRetry).toHaveBeenCalledWith("op-4");
    screen.getByRole("button", { name: "查看原因" }).click();
    expect(props.onShowReason).toHaveBeenCalledWith("op-4");
  });

  it("已接受：撤销", () => {
    const props = renderBar([
      chip({ operation: makeOperation({ id: "op-5", status: "committed", undoToken: "u-1" }) }),
    ]);
    screen.getByRole("button", { name: "撤销" }).click();
    expect(props.onUndo).toHaveBeenCalledWith("op-5");
  });

  it("已丢弃：关闭", () => {
    const props = renderBar([
      chip({ operation: makeOperation({ id: "op-6", status: "discarded" }) }),
    ]);
    expect(screen.getByText("扩展 · 已丢弃")).toBeTruthy();
    screen.getByRole("button", { name: "关闭" }).click();
    expect(props.onClose).toHaveBeenCalledWith("op-6");
  });

  it("无任务时不渲染", () => {
    const { container } = render(
      <TaskBar
        chips={[]}
        onCancel={vi.fn()}
        onAcceptAll={vi.fn()}
        onReviewOne={vi.fn()}
        onDiscard={vi.fn()}
        onRetry={vi.fn()}
        onShowReason={vi.fn()}
        onUndo={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container.querySelector(".task-bar")).toBeNull();
  });
});
