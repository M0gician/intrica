import type { Node } from "@intrica/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeNode } from "../../test/factories";
import { BottomBar, computeActionAvailability } from "../BottomBar";

function nodeMap(...nodes: Node[]): ReadonlyMap<string, Node> {
  return new Map(nodes.map((node) => [node.id, node]));
}

describe("computeActionAvailability：可用性矩阵", () => {
  const a = makeNode({ id: "a", parentId: "root" });
  const b = makeNode({ id: "b", parentId: "root" });
  const inner = makeNode({ id: "inner", parentId: "a" });

  it("单选：收束不可用，连接进入目标选择，扩展/深入可用", () => {
    const { actions } = computeActionAvailability(nodeMap(a, b), new Set(["a"]));
    const expand = actions.find((action) => action.id === "expand");
    const deepen = actions.find((action) => action.id === "deepen");
    const compress = actions.find((action) => action.id === "compress");
    const link = actions.find((action) => action.id === "link");

    expect(expand?.enabled).toBe(true);
    expect(deepen?.enabled).toBe(true);
    expect(deepen?.hint).toBe("在选中节点内部生成");
    expect(compress?.enabled).toBe(false);
    expect(compress?.disabledReason).toBe("至少选择两个节点才能收束");
    expect(link?.enabled).toBe(true);
    expect(link?.hint).toBe("选择目标，连接整组选区");
  });

  it("双选同作用域：全部可用，深入提示结果容器", () => {
    const { actions, scopeId } = computeActionAvailability(nodeMap(a, b), new Set(["a", "b"]));
    expect(scopeId).toBe("root");
    for (const action of actions) expect(action.enabled).toBe(true);
    expect(actions.find((action) => action.id === "deepen")?.hint).toBe("新建结果容器并在其中生成");
    expect(actions.find((action) => action.id === "expand")?.hint).toBe("当前层生成平行节点");
    expect(actions.find((action) => action.id === "compress")?.hint).toBe(
      "创建摘要容器并移入所选节点",
    );
  });

  it("跨层级但无祖先关系：提示“请选择同一层级”", () => {
    const other = makeNode({ id: "other", parentId: "container-x" });
    const container = makeNode({ id: "container-x", kind: "group", parentId: "root" });
    const { actions, scopeId } = computeActionAvailability(
      nodeMap(a, other, container),
      new Set(["a", "other"]),
    );
    expect(scopeId).toBeNull();
    for (const action of actions) {
      expect(action.enabled).toBe(false);
      expect(action.disabledReason).toBe("请选择同一层级");
    }
  });

  it("选区同时含父节点及后代：结构操作拒绝", () => {
    const { actions } = computeActionAvailability(nodeMap(a, inner), new Set(["a", "inner"]));
    for (const action of actions) {
      expect(action.enabled).toBe(false);
      expect(action.disabledReason).toContain("只选择父节点或只选择后代");
    }
  });

  it("PDF selection and PDF scope block generation, but preserve linking", () => {
    const pdf = makeNode({ id: "pdf", kind: "pdf", parentId: "root" });
    const child = makeNode({ id: "note", parentId: "pdf" });
    for (const selection of [new Set(["pdf", "a"]), new Set(["note"])]) {
      const result = computeActionAvailability(nodeMap(a, pdf, child), selection);
      expect(result.blockedPdfNodeIds).toEqual(["pdf"]);
      expect(
        result.actions.filter((action) => action.id !== "link").every((action) => !action.enabled),
      ).toBe(true);
      expect(result.actions.find((action) => action.id === "link")?.enabled).toBe(true);
    }
  });
});

describe("BottomBar 组件", () => {
  const a = makeNode({ id: "a", parentId: "root", title: "甲" });
  const b = makeNode({ id: "b", parentId: "root", title: "乙" });

  function renderBar(selection: ReadonlySet<string>, onAction = vi.fn()) {
    const availability = computeActionAvailability(nodeMap(a, b), selection);
    render(
      <BottomBar
        availability={availability}
        moreOpen={false}
        canInspect={selection.size === 1}
        onAction={onAction}
        onToggleMore={vi.fn()}
        onDelete={vi.fn()}
        onCopy={vi.fn()}
        onInspect={vi.fn()}
      />,
    );
    return onAction;
  }

  it("显示“已选择 N 项”与动作图标", () => {
    renderBar(new Set(["a", "b"]));
    expect(screen.getByText("已选择 2 项")).toBeTruthy();
    expect(screen.getByRole("button", { name: /扩展：当前层生成平行节点/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /深入：新建结果容器并在其中生成/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /收束：创建摘要容器并移入所选节点/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /连接：连接两个选中节点/ })).toBeTruthy();
  });

  it("单选时收束按钮禁用", () => {
    renderBar(new Set(["a"]));
    const compress = screen.getByRole("button", {
      name: /收束（不可用：至少选择两个节点才能收束）/,
    });
    expect(compress.hasAttribute("disabled")).toBe(true);
  });

  it("点击动作触发回调", () => {
    const onAction = renderBar(new Set(["a", "b"]));
    screen.getByRole("button", { name: /深入：/ }).click();
    expect(onAction).toHaveBeenCalledWith("deepen");
  });

  it("未选中时不渲染", () => {
    const { container } = render(
      <BottomBar
        availability={computeActionAvailability(nodeMap(a), new Set())}
        moreOpen={false}
        canInspect={false}
        onAction={vi.fn()}
        onToggleMore={vi.fn()}
        onDelete={vi.fn()}
        onCopy={vi.fn()}
        onInspect={vi.fn()}
      />,
    );
    expect(container.querySelector(".bottom-bar")).toBeNull();
  });

  it("把批量 Agent 按钮放在常规底栏外，并仅在选区含 Agent 时显示", () => {
    const agent = makeNode({
      id: "agent",
      kind: "agent",
      agent: { persona: "", role: "write", enabled: true },
    });
    const onAgentRun = vi.fn();
    const { container } = render(
      <BottomBar
        availability={computeActionAvailability(nodeMap(agent, a), new Set(["agent", "a"]))}
        moreOpen={false}
        canInspect={false}
        onAction={vi.fn()}
        onToggleMore={vi.fn()}
        onDelete={vi.fn()}
        onCopy={vi.fn()}
        onInspect={vi.fn()}
        agentRunState="idle"
        onAgentRun={onAgentRun}
      />,
    );
    const button = screen.getByRole("button", { name: "启动选中 Agent 及其团队" });
    expect(button.closest(".bottom-controls")).toBeTruthy();
    expect(button.closest(".bottom-bar")).toBeNull();
    button.click();
    expect(onAgentRun).toHaveBeenCalledWith("start");
    expect(container.querySelector(".bottom-bar")).toBeTruthy();
  });
});
