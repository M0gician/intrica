import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmStrip } from "../ConfirmStrip";

function renderStrip(
  intent: { type: "expand" | "deepen" | "compress"; selection: string[] },
  overrides: Partial<Parameters<typeof ConfirmStrip>[0]> = {},
) {
  const props = {
    intent: { scopeId: "root", ...intent },
    onBack: vi.fn(),
    onStart: vi.fn(),
    onOpenFullContext: vi.fn(),
    ...overrides,
  };
  render(<ConfirmStrip {...props} />);
  return props;
}

describe("ConfirmStrip：确认区文案", () => {
  it("扩展多选：当前层同级", () => {
    renderStrip({ type: "expand", selection: ["a", "b"] });
    expect(screen.getByText("扩展这 2 项内容")).toBeTruthy();
    expect(screen.getByText("将使用：当前选中的 2 个节点")).toBeTruthy();
    expect(screen.getByText("结果位置：当前层（与选中节点同级）")).toBeTruthy();
  });

  it("深入单选：当前选中节点内部", () => {
    renderStrip({ type: "deepen", selection: ["a"] });
    expect(screen.getByText("深入这 1 项内容")).toBeTruthy();
    expect(screen.getByText("结果位置：当前选中节点内部")).toBeTruthy();
  });

  it("深入多选：新建结果容器", () => {
    renderStrip({ type: "deepen", selection: ["a", "b"] });
    expect(screen.getByText("深入这 2 项内容")).toBeTruthy();
    expect(screen.getByText("结果位置：新建结果容器（当前层）")).toBeTruthy();
  });

  it("收束：新建摘要容器并移入所选节点", () => {
    renderStrip({ type: "compress", selection: ["a", "b", "c"] });
    expect(screen.getByText("收束这 3 项内容")).toBeTruthy();
    expect(screen.getByText("结果位置：新建摘要容器，并移入所选节点")).toBeTruthy();
  });

  it("按钮回调：返回 / 开始生成 / 查看完整上下文", () => {
    const props = renderStrip({ type: "expand", selection: ["a"] });
    screen.getByRole("button", { name: "返回" }).click();
    expect(props.onBack).toHaveBeenCalledTimes(1);
    screen.getByRole("button", { name: "开始生成" }).click();
    expect(props.onStart).toHaveBeenCalledTimes(1);
    screen.getByRole("button", { name: "查看完整上下文" }).click();
    expect(props.onOpenFullContext).toHaveBeenCalledTimes(1);
  });
});
