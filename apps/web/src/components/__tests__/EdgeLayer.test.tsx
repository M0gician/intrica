import type { Edge, Rect } from "@intrica/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeEdge } from "../../test/factories";
import { EdgeLayer } from "../EdgeLayer";

const RECTS: ReadonlyMap<string, Rect> = new Map([
  ["a", { x: 0, y: 0, width: 100, height: 50 }],
  ["b", { x: 200, y: 0, width: 100, height: 50 }],
]);

const TITLES: Record<string, string> = { a: "假设", b: "证据" };

function renderLayer(edges: Edge[], extra: Partial<Parameters<typeof EdgeLayer>[0]> = {}) {
  return render(
    <EdgeLayer
      edges={edges}
      rects={RECTS}
      nodeTitle={(id) => TITLES[id] ?? id}
      onEdgeClick={vi.fn()}
      onEdgeActivate={vi.fn()}
      {...extra}
    />,
  );
}

describe("EdgeLayer：可访问性", () => {
  it("svg 根不使用 role=img，保留 title", () => {
    const { container } = renderLayer([]);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBeNull();
    expect(svg.querySelector("title")?.textContent).toBe("节点连线层");
  });

  it("user_link 连线是 role=button 且可键盘聚焦", () => {
    renderLayer([makeEdge({ id: "e-1", from: "a", to: "b" })]);
    const path = screen.getByRole("button", { name: "连接：假设 ↔ 证据，可删除" });
    expect(path.getAttribute("tabindex")).toBe("0");
  });

  it("来源连线保留语义且可删除，不绘制箭头", () => {
    renderLayer([
      makeEdge({ id: "e-2", from: "a", to: "b", type: "derived_from", directed: true }),
    ]);
    expect(screen.getByRole("button", { name: "来源：假设 派生自 证据，可删除" })).toBeTruthy();
    expect(document.querySelector("[marker-end]")).toBeNull();
  });

  it("Enter/Space 激活删除确认", () => {
    const onEdgeActivate = vi.fn();
    const edge = makeEdge({ id: "e-3", from: "a", to: "b" });
    renderLayer([edge], { onEdgeActivate });
    const path = screen.getByRole("button", { name: /连接：假设/ });
    fireEvent.keyDown(path, { key: "Enter" });
    expect(onEdgeActivate).toHaveBeenCalledWith(edge);
    fireEvent.keyDown(path, { key: " " });
    expect(onEdgeActivate).toHaveBeenCalledTimes(2);
  });

  it("提供视觉隐藏的关系列表（读屏顺序不依赖坐标）", () => {
    renderLayer([
      makeEdge({ id: "e-4", from: "a", to: "b" }),
      makeEdge({ id: "e-5", from: "a", to: "b", type: "derived_from", directed: true }),
    ]);
    const list = screen.getByRole("list", { name: "关系列表" });
    const items = Array.from(list.querySelectorAll("li")).map((item) => item.textContent);
    expect(items).toEqual(["连接：假设 ↔ 证据，可删除", "来源：假设 派生自 证据，可删除"]);
  });

  it("本地预览中的连线标记为创建中", () => {
    renderLayer([], { pendingEdges: [makeEdge({ id: "e-6", from: "a", to: "b" })] });
    expect(screen.getByRole("img", { name: "连接创建中：假设 ↔ 证据" })).toBeTruthy();
  });
});
