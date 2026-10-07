import type { Edge, Node, Operation } from "@intrica/contracts";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeEdge, makeNode, makeOperation } from "../../test/factories";
import { InspectorPanel } from "../InspectorPanel";

function buildGraph() {
  const nodes: Node[] = [
    makeNode({ id: "root", kind: "group", parentId: null, title: "根", childOrder: ["a", "b"] }),
    makeNode({
      id: "a",
      parentId: "root",
      title: "证据甲",
      text: "# 结论\n- 要点一\n正文内容",
      childOrder: ["c"],
    }),
    makeNode({ id: "b", parentId: "root", title: "证据乙" }),
    makeNode({ id: "c", parentId: "a", title: "子项一" }),
    makeNode({ id: "d", parentId: "root", title: "派生结果" }),
  ];
  const edges: Edge[] = [
    makeEdge({ id: "e-1", from: "d", to: "a", type: "derived_from", directed: true }),
    makeEdge({ id: "e-2", from: "b", to: "a", type: "user_link" }),
    makeEdge({ id: "e-3", from: "a", to: "c", type: "derived_from", directed: true }),
  ];
  const operations: Operation[] = [
    makeOperation({ id: "op-1", status: "candidate", selection: ["a"], outputIds: ["d"] }),
  ];
  return {
    nodes: new Map(nodes.map((node) => [node.id, node])),
    edges: new Map(edges.map((edge) => [edge.id, edge])),
    operations: new Map(operations.map((operation) => [operation.id, operation])),
  };
}

function renderPanel(nodeOverrides: Partial<Node> = {}, onSave = vi.fn().mockResolvedValue(true)) {
  const graph = buildGraph();
  const node = { ...graph.nodes.get("a")!, ...nodeOverrides };
  const props = {
    node,
    nodes: graph.nodes,
    edges: graph.edges,
    operations: graph.operations,
    onClose: vi.fn(),
    onSelectNode: vi.fn(),
    onOpenOverlay: vi.fn(),
    onSave,
  };
  render(<InspectorPanel {...props} />);
  return props;
}

describe("InspectorPanel：完整内容与 Markdown-lite", () => {
  it("待办详情直接提供完成状态和正文编辑入口", () => {
    const onSave = vi.fn().mockResolvedValue(true);
    renderPanel(
      {
        id: "todo",
        kind: "todo",
        title: "整理证据",
        text: "- [ ] 核对来源",
        todo: { completed: false },
      },
      onSave,
    );
    expect(screen.getByRole("checkbox")).toBeTruthy();
    expect(screen.getByText("核对来源")).toBeTruthy();
  });
  it("正文用 Markdown-lite 渲染（标题/列表）", () => {
    renderPanel();
    expect(screen.getByRole("heading", { level: 1, name: "结论" })).toBeTruthy();
    expect(screen.getByText(/要点一/)).toBeTruthy();
  });

  it("注入的 <script> 字符串按文本渲染", () => {
    renderPanel({ text: '前文 <script>alert("x")</script> 后文' });
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText(/<script>alert/)).toBeTruthy();
  });
});

describe("InspectorPanel：来源和关系", () => {
  it("派生自 / 被引用 / 连接三个列表", () => {
    const props = renderPanel();
    fireEvent.click(screen.getByText(/关系与来源/));
    const derivedFrom = within(screen.getByRole("region", { name: "派生自" }));
    const referencedBy = within(screen.getByRole("region", { name: "被引用" }));
    const links = within(screen.getByRole("region", { name: "连接" }));
    expect(derivedFrom.getByRole("button", { name: "子项一" })).toBeTruthy();
    expect(referencedBy.getByRole("button", { name: "派生结果" })).toBeTruthy();
    expect(links.getByRole("button", { name: "证据乙" })).toBeTruthy();

    props.onSelectNode.mockClear();
    referencedBy.getByRole("button", { name: "派生结果" }).click();
    expect(props.onSelectNode).toHaveBeenCalledWith("d");
  });
});

describe("InspectorPanel：子节点与最近操作", () => {
  it("子节点列表点击选中，容器可进入内部", () => {
    const props = renderPanel();
    fireEvent.click(screen.getByText("子节点（1）"));
    const children = within(screen.getByRole("region", { name: "子节点" }));
    children.getByRole("button", { name: "子项一" }).click();
    expect(props.onSelectNode).toHaveBeenCalledWith("c");
    screen.getByRole("button", { name: /进入内部/ }).click();
    expect(props.onOpenOverlay).toHaveBeenCalledWith("a");
  });

  it("最近操作列出触及该节点的操作", () => {
    renderPanel();
    expect(screen.getByText("扩展 · 未提交")).toBeTruthy();
  });
});

describe("InspectorPanel：编辑", () => {
  it("标题失焦保存", () => {
    const onSave = vi.fn().mockResolvedValue(true);
    renderPanel({}, onSave);
    const titleInput = screen.getByLabelText("节点标题");
    fireEvent.focus(titleInput);
    fireEvent.change(titleInput, { target: { value: "新标题" } });
    fireEvent.blur(titleInput);
    expect(onSave).toHaveBeenCalledWith("a", { title: "新标题" });
  });

  it("已有正文默认渲染，可切换源码编辑", () => {
    renderPanel();
    expect(screen.getByRole("heading", { name: "结论" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(screen.getByLabelText("编辑节点正文").getAttribute("contenteditable")).toBe("true");
    expect(screen.queryByRole("button", { name: /^编辑$/ })).toBeNull();
    expect(screen.getByRole("button", { name: "预览正文" })).toBeTruthy();
  });

  it("图片节点显示原图与替代文本编辑", () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const graph = buildGraph();
    const image = makeNode({
      id: "img",
      kind: "image",
      parentId: "root",
      title: "截图",
      assetId: "asset-1",
      assetVersion: 2,
      alt: "旧替代文本",
    });
    render(
      <InspectorPanel
        node={image}
        nodes={graph.nodes}
        edges={graph.edges}
        operations={graph.operations}
        onClose={vi.fn()}
        onSelectNode={vi.fn()}
        onOpenOverlay={vi.fn()}
        onSave={onSave}
      />,
    );
    const img = screen.getByAltText("旧替代文本");
    expect(img.getAttribute("src")).toBe("/api/v2/assets/asset-1");
    const altInput = screen.getByLabelText("替代文本");
    fireEvent.focus(altInput);
    fireEvent.change(altInput, { target: { value: "新替代文本" } });
    fireEvent.blur(altInput);
    expect(onSave).toHaveBeenCalledWith("img", { alt: "新替代文本" });
  });
});
