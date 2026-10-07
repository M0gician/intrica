import type { Node, SnapshotResponse } from "@intrica/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceController } from "../../state/controller";
import { store } from "../../state/store";
import type { OverlaySpaceState } from "../../state/types";
import { makeNode, makeOperation } from "../../test/factories";
import { Canvas } from "../Canvas";

vi.mock("../../api/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../api/client")>();
  return {
    ...mod,
    createApiClient: (...args: Parameters<typeof mod.createApiClient>) => ({
      ...mod.createApiClient(...args),
      previewOperation: vi.fn().mockResolvedValue({
        preview: {
          draft: {
            snapshotVersion: 1,
            scope: { id: "root", kind: "group", title: "根" },
            selection: ["a", "b"],
            contextOnlyNodeIds: [],
            nodes: [
              { id: "a", kind: "text", title: "甲", revision: 1, containerPath: ["root"] },
              { id: "b", kind: "text", title: "乙", revision: 1, containerPath: ["root"] },
            ],
            edges: [],
            includeDescendants: [],
            omittedNodeIds: [],
            instruction: "",
          },
          neighborIds: [],
          descendantCounts: {},
          estimatedChars: 24,
          budgetChars: 12000,
          visionRequired: false,
          visionSupported: true,
        },
      }),
    }),
  };
});

function makeController(): WorkspaceController {
  return {
    commitMove: vi.fn().mockResolvedValue(true),
    undoWorkspace: vi.fn().mockResolvedValue(undefined),
    createLink: vi.fn().mockResolvedValue(true),
    deleteLink: vi.fn().mockResolvedValue(true),
    deleteNodes: vi.fn().mockResolvedValue(true),
    copyNodes: vi.fn().mockResolvedValue([]),
    saveNodeContent: vi.fn().mockResolvedValue(true),
    createTextNode: vi.fn().mockResolvedValue("n-new"),
    createImageNode: vi.fn().mockResolvedValue("n-img"),
    createPdfNode: vi.fn().mockResolvedValue("n-pdf"),
    showToast: vi.fn(),
    createOperation: vi.fn().mockResolvedValue(undefined),
    acceptOperation: vi.fn().mockResolvedValue(undefined),
    discardOperation: vi.fn().mockResolvedValue(undefined),
    cancelOperation: vi.fn().mockResolvedValue(undefined),
    retryOperation: vi.fn().mockResolvedValue(undefined),
    undoOperation: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkspaceController;
}

function defaultNodes(): Node[] {
  return [
    makeNode({
      id: "root",
      kind: "group",
      parentId: null,
      title: "根",
      childOrder: ["c1", "n1", "n2"],
    }),
    makeNode({
      id: "c1",
      kind: "group",
      parentId: "root",
      title: "容器",
      childOrder: ["alpha"],
      position: { x: 400, y: 0, width: 280, height: 200 },
    }),
    makeNode({
      id: "alpha",
      kind: "text",
      parentId: "c1",
      title: "子项",
      position: { x: 16, y: 16, width: 240, height: 160 },
    }),
    makeNode({
      id: "n1",
      kind: "text",
      parentId: "root",
      title: "笔记一",
      position: { x: 0, y: 0, width: 240, height: 160 },
    }),
    makeNode({
      id: "n2",
      kind: "text",
      parentId: "root",
      title: "笔记二",
      position: { x: 0, y: 300, width: 240, height: 160 },
    }),
  ];
}

function makeSnapshot(nodes: Node[]): SnapshotResponse {
  return {
    activeCanvasId: "root",
    canvasSeq: "0",
    graphRevision: 1,
    nodes,
    edges: [],
    operations: [],
    candidateNodes: [],
    candidateContainers: [],
    latestModelBatchAt: null,
    latestModelBatchOperationId: null,
  };
}

function makeOverlay(overrides: Partial<OverlaySpaceState> = {}): OverlaySpaceState {
  return {
    containerId: "c1",
    readonly: false,
    previewOperationId: null,
    bounds: { x: 800, y: 0, width: 500, height: 400 },
    displacement: new Map(),
    ...overrides,
  };
}

function resetStore() {
  act(() => {
    store.dispatch({ type: "snapshotLoaded", snapshot: makeSnapshot(defaultNodes()) });
    store.dispatch({ type: "overlayClosed" });
    store.dispatch({ type: "selectionChanged", selection: new Set() });
    store.dispatch({ type: "surfaceClosed" });
    store.dispatch({ type: "panelClosed" });
    store.dispatch({ type: "toastDismissed" });
    store.dispatch({ type: "viewTransformChanged", pan: { x: 0, y: 0 }, zoom: 1 });
    store.dispatch({ type: "nudgeChanged", nudge: null });
    store.dispatch({ type: "deletingCleared" });
    store.dispatch({ type: "statusMessageSet", message: "" });
  });
}

function viewportElement(): HTMLElement {
  const element = document.querySelector(".canvas-viewport");
  if (!element) throw new Error("画布未渲染");
  return element as HTMLElement;
}

function nodeArticle(name: string | RegExp): HTMLElement {
  return screen.getByRole("article", { name });
}

beforeEach(() => {
  resetStore();
});

describe("Canvas：选择与详情侧栏", () => {
  it("单击更新选区；显式查看后加选保留侧栏", () => {
    render(<Canvas controller={makeController()} />);
    fireEvent.click(nodeArticle(/笔记一/));
    expect([...store.getState().view.selection]).toEqual(["n1"]);
    expect(screen.getByLabelText("工作区侧栏").hasAttribute("hidden")).toBe(true);
    fireEvent.doubleClick(nodeArticle(/笔记一/));
    expect(screen.getByLabelText(/节点详情：笔记一/)).toBeTruthy();

    fireEvent.click(nodeArticle(/笔记二/), { shiftKey: true });
    expect(store.getState().view.selection.size).toBe(2);
    expect(screen.getByLabelText("工作区侧栏").hasAttribute("hidden")).toBe(false);
  });

  it("容器双击打开详情，不进入内部", () => {
    render(<Canvas controller={makeController()} />);
    fireEvent.click(nodeArticle(/容器/));
    expect([...store.getState().view.selection]).toEqual(["c1"]);
    expect(store.getState().view.overlaySpace).toBeNull();

    fireEvent.doubleClick(nodeArticle(/容器/));
    expect(store.getState().view.overlaySpace).toBeNull();
    expect(store.getState().view.panel).toEqual({ type: "inspector", nodeId: "c1" });
  });
});

describe("Canvas：浮层互斥与 Esc 层级", () => {
  it("打开新浮层自动关闭旧浮层；打开侧栏关闭浮层", () => {
    render(<Canvas controller={makeController()} />);
    act(() => {
      store.dispatch({
        type: "surfaceOpened",
        surface: { type: "create", position: { x: 10, y: 10 } },
      });
    });
    expect(screen.getByRole("menu", { name: "新建菜单" })).toBeTruthy();

    act(() => {
      store.dispatch({
        type: "surfaceOpened",
        surface: {
          type: "confirm",
          intent: { type: "expand", scopeId: "root", selection: ["n1"] },
        },
      });
    });
    expect(screen.queryByRole("menu", { name: "新建菜单" })).toBeNull();
    expect(screen.getByText("扩展这 1 项内容")).toBeTruthy();

    act(() => {
      store.dispatch({ type: "panelOpened", panel: { type: "inspector", nodeId: "n1" } });
    });
    expect(store.getState().view.surface).toBeNull();
  });

  it("Esc 层级：浮层 → 侧栏 → 临时空间 → 选区", () => {
    render(<Canvas controller={makeController()} />);
    act(() => {
      store.dispatch({ type: "selectionChanged", selection: new Set(["n1"]) });
      store.dispatch({ type: "panelOpened", panel: { type: "inspector", nodeId: "n1" } });
      store.dispatch({ type: "overlayOpened", overlay: makeOverlay() });
      store.dispatch({
        type: "surfaceOpened",
        surface: { type: "create", position: { x: 10, y: 10 } },
      });
    });
    const viewport = viewportElement();

    fireEvent.keyDown(viewport, { key: "Escape" });
    expect(store.getState().view.surface).toBeNull();
    expect(store.getState().view.panel).not.toBeNull();

    fireEvent.keyDown(viewport, { key: "Escape" });
    expect(store.getState().view.panel).toBeNull();
    expect(store.getState().view.overlaySpace).not.toBeNull();

    fireEvent.keyDown(viewport, { key: "Escape" });
    expect(store.getState().view.overlaySpace).toBeNull();
    expect(store.getState().view.selection.size).toBe(1);

    fireEvent.keyDown(viewport, { key: "Escape" });
    expect(store.getState().view.selection.size).toBe(0);
  });
});

describe("Canvas：空白单击与双击创建", () => {
  it("PDF menu chooses a PDF file picker and a dropped PDF never enters text decoding", async () => {
    const controller = makeController();
    render(<Canvas controller={controller} />);
    fireEvent.doubleClick(viewportElement(), { clientX: 300, clientY: 260 });
    fireEvent.click(screen.getByRole("menuitem", { name: "PDF" }));
    expect(document.querySelector<HTMLInputElement>('input[type="file"]')?.accept).toBe(
      "application/pdf,.pdf",
    );
    const file = new File(["%PDF-1.7"], "Uploaded.PDF");
    fireEvent.drop(viewportElement(), {
      clientX: 300,
      clientY: 260,
      dataTransfer: {
        getData: () => "",
        files: [file],
        items: [{ kind: "file", type: "", webkitGetAsEntry: () => null }],
      },
    });
    await waitFor(() => expect(controller.createImageNode).toHaveBeenCalled());
    expect(controller.createImageNode).toHaveBeenCalledWith("root", expect.any(Object), file, {
      title: "Uploaded.PDF",
      alt: "Uploaded.PDF",
    });
    expect(controller.createTextNode).not.toHaveBeenCalled();
  });
  it("a server PDF drop creates a live PDF reference without reuploading the document", async () => {
    const controller = makeController();
    render(<Canvas controller={controller} />);
    fireEvent.drop(viewportElement(), {
      clientX: 300,
      clientY: 260,
      dataTransfer: {
        getData: (type: string) =>
          type === "application/x-intrica-local-resource"
            ? JSON.stringify({ name: "Reference.pdf", path: "/docs/Reference.pdf", type: "file" })
            : "",
        files: [],
        items: [],
      },
    });
    await waitFor(() =>
      expect(controller.createPdfNode).toHaveBeenCalledWith(
        "root",
        expect.any(Object),
        "/docs/Reference.pdf",
        "Reference.pdf",
      ),
    );
    expect(controller.createImageNode).not.toHaveBeenCalled();
    expect(controller.createTextNode).not.toHaveBeenCalled();
  });
  it("空白单击只取消选择并关闭浮层，不打开新建菜单", () => {
    const controller = makeController();
    render(<Canvas controller={controller} />);
    act(() => {
      store.dispatch({ type: "selectionChanged", selection: new Set(["n1"]) });
      store.dispatch({
        type: "surfaceOpened",
        surface: { type: "create", position: { x: 10, y: 10 } },
      });
    });
    const viewport = viewportElement();

    fireEvent.pointerDown(viewport, { button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(window, { button: 0, clientX: 5, clientY: 5 });

    expect(store.getState().view.surface).toBeNull();
    expect(store.getState().view.selection.size).toBe(0);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(controller.createTextNode).not.toHaveBeenCalled();
  });

  it("双击空白先选择类型，再创建文字节点并选中", async () => {
    const controller = makeController();
    render(<Canvas controller={controller} />);
    fireEvent.doubleClick(viewportElement(), { clientX: 5, clientY: 5 });
    fireEvent.click(screen.getByRole("menuitem", { name: /文字/ }));
    expect(controller.createTextNode).toHaveBeenCalledWith(
      "root",
      expect.objectContaining({ x: -115, y: -75 }),
    );
    await waitFor(() => {
      expect([...store.getState().view.selection]).toEqual(["n-new"]);
    });
  });
});

describe("Canvas：底栏动作与生成确认", () => {
  it("PDF action opens the real Agent composer with a draft, without sending or creating a task", async () => {
    const controller = makeController();
    const pdf = makeNode({
      id: "pdf-doc",
      kind: "pdf",
      parentId: "root",
      title: "Report",
      assetId: "asset",
    });
    act(() =>
      store.dispatch({
        type: "graphDelta",
        delta: {
          canvasId: "root",
          graphRevision: store.getState().graph.graphRevision + 1,
          kind: "node.create",
          command: null,
          modelBatch: null,
          nodes: [pdf],
          deletedNodeIds: [],
          edges: [],
          deletedEdgeIds: [],
        },
      }),
    );
    render(<Canvas controller={controller} />);
    act(() => store.dispatch({ type: "selectionChanged", selection: new Set([pdf.id]) }));
    expect(
      (screen.getByRole("button", { name: /扩展（不可用：PDF/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "交给 Agent 阅读 PDF" }));
    const input = (await screen.findByRole("textbox", { name: "模型问题" })) as HTMLTextAreaElement;
    await waitFor(() => expect(input.value).toContain("pdf-doc"));
    expect(input.value).toContain("read");
    expect(document.activeElement).toBe(input);
    expect(controller.createOperation).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "Existing draft" } });
    fireEvent.click(screen.getByRole("button", { name: "交给 Agent 阅读 PDF" }));
    await waitFor(() => expect(input.value).toContain("Existing draft\n\n"));
    expect(input.value.match(/pdf-doc/g)).toHaveLength(1);
  });

  it("多选点深入：确认区文案 → 开始生成 → createOperation", () => {
    const controller = makeController();
    render(<Canvas controller={controller} />);
    act(() => {
      store.dispatch({ type: "selectionChanged", selection: new Set(["n1", "n2"]) });
    });

    fireEvent.click(screen.getByRole("button", { name: /深入：新建结果容器并在其中生成/ }));
    expect(screen.getByText("深入这 2 项内容")).toBeTruthy();
    expect(screen.getByText("结果位置：新建结果容器（当前层）")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));
    expect(controller.createOperation).toHaveBeenCalledWith({
      type: "deepen",
      scopeId: "root",
      selection: ["n1", "n2"],
      includeDescendants: [],
      includeConnected: false,
      instruction: "",
    });
    expect(store.getState().view.surface).toBeNull();
  });

  it("查看完整上下文打开对话框，确认后发起生成", async () => {
    const controller = makeController();
    render(<Canvas controller={controller} />);
    act(() => {
      store.dispatch({ type: "selectionChanged", selection: new Set(["n1", "n2"]) });
    });

    fireEvent.click(screen.getByRole("button", { name: /深入：新建结果容器并在其中生成/ }));
    fireEvent.click(screen.getByRole("button", { name: "查看完整上下文" }));

    const dialog = await screen.findByRole("dialog", { name: /深入上下文预览/ });
    expect(within(dialog).getByText("将发送的节点（2）")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认深入" }));
    expect(controller.createOperation).toHaveBeenCalledWith(
      expect.objectContaining({ type: "deepen", scopeId: "root" }),
    );
  });
});

describe("Canvas：删除确认逻辑", () => {
  it("无子项单选不弹确认，直接删除", () => {
    const controller = makeController();
    render(<Canvas controller={controller} />);
    fireEvent.pointerEnter(nodeArticle(/笔记一/));
    const row = screen.getByRole("toolbar", { name: "节点操作" });
    fireEvent.click(within(row).getByRole("button", { name: "删除" }));
    expect(controller.deleteNodes).toHaveBeenCalledWith(["n1"]);
    expect(store.getState().view.surface?.type).not.toBe("deleteConfirm");
  });

  it("含子项节点弹确认并显示影响范围", () => {
    render(<Canvas controller={makeController()} />);
    fireEvent.pointerEnter(nodeArticle(/容器/));
    const row = screen.getByRole("toolbar", { name: "节点操作" });
    fireEvent.click(within(row).getByRole("button", { name: "删除" }));
    expect(screen.getByRole("alertdialog", { name: "删除确认" })).toBeTruthy();
    expect(screen.getByText("将删除 2 个节点（含 1 个子项）")).toBeTruthy();
  });

  it("多选从更多菜单删除：弹确认后执行", () => {
    const controller = makeController();
    render(<Canvas controller={controller} />);
    act(() => {
      store.dispatch({ type: "selectionChanged", selection: new Set(["n1", "n2"]) });
    });
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /删除/ }));
    expect(screen.getByText("将删除 2 个节点")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(controller.deleteNodes).toHaveBeenCalledWith(["n1", "n2"]);
  });
});

describe("Canvas：只读候选预览空间屏蔽", () => {
  it("屏蔽底栏、nodeActions、方向键与 Cmd/Ctrl+Z", () => {
    const controller = makeController();
    render(<Canvas controller={controller} />);
    act(() => {
      store.dispatch({ type: "selectionChanged", selection: new Set(["n1"]) });
      store.dispatch({
        type: "overlayOpened",
        overlay: makeOverlay({ readonly: true, previewOperationId: "op-x" }),
      });
    });
    expect(screen.queryByRole("toolbar", { name: "选中操作栏" })).toBeNull();

    fireEvent.pointerEnter(nodeArticle(/笔记一/));
    expect(screen.queryByRole("toolbar", { name: "节点操作" })).toBeNull();

    const viewport = viewportElement();
    fireEvent.keyDown(viewport, { key: "ArrowRight" });
    expect(store.getState().view.nudge).toBeNull();
    fireEvent.keyDown(viewport, { key: "z", ctrlKey: true });
    expect(controller.undoWorkspace).not.toHaveBeenCalled();
  });
});

describe("Canvas：overlay 候选与吞点击", () => {
  it("内部空间渲染挂在容器上的候选，任务条出现 chip", () => {
    render(<Canvas controller={makeController()} />);
    act(() => {
      store.dispatch({ type: "overlayOpened", overlay: makeOverlay() });
      store.dispatch({
        type: "operationUpserted",
        operation: makeOperation({
          id: "op-1",
          status: "running",
          scopeId: "c1",
          outputParentId: "c1",
        }),
        queuePosition: null,
      });
      store.dispatch({
        type: "proposalLoaded",
        operation: makeOperation({
          id: "op-1",
          status: "running",
          scopeId: "c1",
          outputParentId: "c1",
        }),
        candidateContainers: [],
        candidateNodes: [
          {
            id: "cand-1",
            kind: "text",
            parentId: "c1",
            position: { x: 16, y: 16, width: 240, height: 160 },
            lifecycle: "candidate",
            operationId: "op-1",
            origin: "model",
            title: "候选甲",
          },
        ],
      });
    });

    const region = screen.getByRole("region", { name: /临时内部空间/ });
    expect(within(region).getByRole("article", { name: /候选甲/ })).toBeTruthy();
    expect(screen.getByText("扩展 · 生成中")).toBeTruthy();
  });

  it("空间打开时吞掉空白点击：关闭空间且不开菜单", () => {
    const controller = makeController();
    render(<Canvas controller={controller} />);
    act(() => {
      store.dispatch({ type: "overlayOpened", overlay: makeOverlay() });
    });
    const viewport = viewportElement();

    fireEvent.pointerDown(viewport, { button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(window, { button: 0, clientX: 5, clientY: 5 });
    expect(store.getState().view.overlaySpace).toBeNull();
    expect(store.getState().view.surface).toBeNull();
    expect(controller.createTextNode).not.toHaveBeenCalled();
  });
});
