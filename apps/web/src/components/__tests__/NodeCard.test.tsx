import type { CandidateNodeProjection, Node } from "@intrica/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CandidateCard } from "../../features/canvas/nodes/CandidateCards";
import type { NodeCardProps } from "../../features/canvas/nodes/types";
import { makeNode } from "../../test/factories";
import { NodeCard } from "../NodeCard";

function renderNodeCard(overrides: Partial<NodeCardProps> & { node?: Node } = {}) {
  const props: NodeCardProps = {
    tier: "user",
    selected: false,
    left: 0,
    top: 0,
    childCount: 0,
    crossScopeCount: 0,
    generating: false,
    dropHighlight: false,
    deleting: false,
    onSelect: vi.fn(),
    onOpenTeam: vi.fn(),
    onHeaderPointerDown: vi.fn(),
    onInspect: vi.fn(),
    onHoverChange: vi.fn(),
    ...overrides,
    node: overrides.node ?? makeNode({ id: "n-1", title: "假设", text: "正文内容" }),
  };
  render(<NodeCard {...props} />);
  return props;
}

describe("NodeCard：颜色等级与徽章", () => {
  it("最近一批模型产物显示紧凑“最近生成”徽章", () => {
    renderNodeCard({ tier: "latest" });
    expect(screen.getByText("最近生成")).toBeTruthy();
    const article = screen.getByRole("article", { name: /最近生成/ });
    expect(article.className).toContain("tier-latest");
  });

  it("历史模型产物与用户节点不显示长标签", () => {
    renderNodeCard({ tier: "history" });
    expect(screen.queryByText("模型产物")).toBeNull();
    expect(screen.queryByText("最近生成")).toBeNull();
    renderNodeCard({ node: makeNode({ id: "n-2", title: "普通", text: "x" }), tier: "user" });
    expect(screen.queryByText("文字节点")).toBeNull();
  });
});

describe("NodeCard：摘要与查看详情", () => {
  it("PDF cards use the server thumbnail for assets and a keyboard-openable placeholder for server references", () => {
    renderNodeCard({
      node: makeNode({ id: "pdf-asset", kind: "pdf", title: "Uploaded.pdf", assetId: "pdf-asset" }),
    });
    expect(screen.getByRole("img").getAttribute("src")).toContain(
      "/api/v2/assets/pdf-asset?variant=thumb",
    );
    const props = renderNodeCard({
      node: makeNode({
        id: "pdf-ref",
        kind: "pdf",
        title: "Reference.pdf",
        resource: { type: "file", path: "/data/ref.pdf" },
      }),
    });
    expect(screen.getByText("双击阅读 PDF")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("article", { name: "PDF：Reference.pdf" }), {
      key: "Enter",
    });
    expect(props.onInspect).toHaveBeenCalledWith("pdf-ref");
    expect(document.querySelector('img[src^="data:application/pdf"]')).toBeNull();
  });
  it("待办节点以便签展示正文并支持勾选", () => {
    const onSaveTodo = vi.fn().mockResolvedValue(true);
    renderNodeCard({
      node: makeNode({
        id: "todo-1",
        kind: "todo",
        title: "核对来源",
        text: "- [ ] 检查原始文件",
        todo: { completed: false },
      }),
      onSaveTodo,
    });
    expect(screen.getByText("检查原始文件")).toBeTruthy();
    const checkbox = screen.getByRole("checkbox");
    checkbox.click();
    expect(onSaveTodo).toHaveBeenCalledWith("todo-1", "- [x] 检查原始文件", true);
  });
  it("短内容不显示“查看详情”，长内容显示", () => {
    renderNodeCard();
    expect(screen.queryByRole("button", { name: "查看详情" })).toBeNull();

    const longText = Array.from({ length: 8 }, (_, index) => `第 ${index + 1} 行内容`).join("\n");
    renderNodeCard({ node: makeNode({ id: "n-3", title: "长文", text: longText }) });
    expect(screen.getByRole("button", { name: "查看详情" })).toBeTruthy();
  });

  it("子项数量与生成中状态标签", () => {
    renderNodeCard({ childCount: 3, generating: true });
    expect(screen.getByText("子项 3")).toBeTruthy();
    expect(screen.getByText("生成中")).toBeTruthy();
  });

  it("正文预览不包含输入框", () => {
    renderNodeCard({ selected: true });
    expect(document.querySelector(".node-card textarea")).toBeNull();
    expect(document.querySelector(".node-card input")).toBeNull();
  });
});

describe("NodeCard：候选卡片", () => {
  const candidate: CandidateNodeProjection = {
    id: "cand-1",
    kind: "text",
    parentId: "root",
    position: { x: 720, y: 80, width: 240, height: 160 },
    lifecycle: "candidate",
    operationId: "op-1",
    origin: "model",
    title: "候选结果",
    text: "候选正文",
  };

  it("未提交候选：紫色虚线样式与“未提交”标签", () => {
    render(<CandidateCard candidate={candidate} status="candidate" />);
    const article = screen.getByRole("article", { name: /未提交/ });
    expect(article.className).toContain("candidate");
    expect(screen.getByText("未提交")).toBeTruthy();
    expect(article.getAttribute("tabindex")).toBeNull();
  });

  it("生成中候选：稳定轮廓与“生成中”标签", () => {
    render(<CandidateCard candidate={candidate} status="running" />);
    const article = screen.getByRole("article", { name: /生成中/ });
    expect(article.className).toContain("candidate-outline");
    expect(screen.getByText("生成中")).toBeTruthy();
  });
});
