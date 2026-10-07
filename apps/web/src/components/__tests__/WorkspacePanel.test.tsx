import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionServices, createSessionConnection } from "../../api/connection";
import { WorkspacePanel } from "../WorkspacePanel";

vi.mock("../FilesPanel", () => ({
  FilesPanel: (props: ComponentProps<typeof import("../FilesPanel").FilesPanel>) => (
    <div
      data-testid="files"
      data-root={props.root}
      data-workspace={props.workspacePath}
      data-file={props.openFileTarget?.path}
    >
      <button type="button" onClick={() => props.onRoot("/chosen/directory")}>
        Choose directory
      </button>
      <button type="button" onClick={() => props.onRoot("~")}>
        Choose home
      </button>
    </div>
  ),
}));
vi.mock("../AgentPanel", () => ({
  AgentPanel: ({ onOpenFile }: { onOpenFile: (path: string) => void }) => (
    <button type="button" onClick={() => onOpenFile("/chosen/report.pdf")}>
      Open direct file
    </button>
  ),
}));
vi.mock("../TerminalPanel", () => ({
  TerminalPanel: ({ cwd }: { cwd: string }) => <div data-testid="terminal" data-cwd={cwd} />,
}));
vi.mock("../InspectorPanel", () => ({ InspectorPanel: () => null }));
vi.mock("../BrowserPanel", () => ({ BrowserPanel: () => null }));
vi.mock("../../features/conversations/AgentCollaboration", () => ({
  AgentCollaboration: () => null,
}));

afterEach(cleanup);

function rootResult() {
  let resolve!: (value: { path: string }) => void;
  const promise = new Promise<{ path: string }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function host(id: string) {
  const connection = createSessionConnection(`http://${id}:3001`, id, `binding-${id}`);
  const request = vi.fn();
  const wrap = (children: ReactNode) => (
    <ConnectionServices.Provider
      value={{ ...connection, transport: { ...connection.transport, request } }}
    >
      {children}
    </ConnectionServices.Provider>
  );
  return { wrap, request };
}
function panelProps(): ComponentProps<typeof WorkspacePanel> {
  return {
    canvasId: "canvas-a",
    node: undefined,
    nodes: new Map(),
    edges: new Map(),
    operations: new Map(),
    mode: "files",
    open: true,
    width: 480,
    onModeChange: vi.fn(),
    onWidthChange: vi.fn(),
    onImport: vi.fn(),
    onClose: vi.fn(),
    onSelectNode: vi.fn(),
    onOpenOverlay: vi.fn(),
    onSave: vi.fn(),
  };
}

it("starts at server home without waiting for the workspace root and never overwrites user navigation with a late result", async () => {
  const remote = host("beta");
  const root = rootResult();
  remote.request.mockReturnValue(root.promise);
  render(remote.wrap(<WorkspacePanel {...panelProps()} />));
  expect((await screen.findByTestId("files")).dataset.root).toBe("~");
  fireEvent.click(screen.getByRole("button", { name: "Choose directory" }));
  await act(async () => {
    root.resolve({ path: "/beta/canvas-a/shared" });
    await root.promise;
  });
  expect(screen.getByTestId("files").dataset.root).toBe("/chosen/directory");
  expect(screen.getByTestId("files").dataset.workspace).toBe("/beta/canvas-a/shared");
});

it("preserves explicit directory targets and direct file previews across workspace discovery", async () => {
  const remote = host("beta");
  const root = rootResult();
  remote.request.mockReturnValue(root.promise);
  const props = panelProps();
  const target = {
    type: "directory" as const,
    path: "/linked/folder",
    nodeId: "node",
    nonce: "target-1",
  };
  const view = render(remote.wrap(<WorkspacePanel {...props} resourceTarget={target} />));
  expect((await screen.findByTestId("files")).dataset.root).toBe(target.path);
  fireEvent.click(screen.getByRole("button", { name: "Choose directory" }));
  expect(screen.getByTestId("files").dataset.root).toBe("/chosen/directory");
  view.rerender(remote.wrap(<WorkspacePanel {...props} mode="agent" />));
  fireEvent.click(await screen.findByRole("button", { name: "Open direct file" }));
  expect(screen.getByTestId("files").dataset.root).toBe("/chosen");
  expect(screen.getByTestId("files").dataset.file).toBe("/chosen/report.pdf");
  await act(async () => {
    root.resolve({ path: "/beta/canvas-a/shared" });
    await root.promise;
  });
  expect(screen.getByTestId("files").dataset.root).toBe("/chosen");
  expect(screen.getByTestId("files").dataset.file).toBe("/chosen/report.pdf");
});

it("isolates navigation and late workspace results across canvases and servers", async () => {
  const first = host("beta");
  const second = host("another");
  const oldRoot = rootResult();
  const nextCanvasRoot = rootResult();
  const nextServerRoot = rootResult();
  first.request.mockReturnValueOnce(oldRoot.promise).mockReturnValueOnce(nextCanvasRoot.promise);
  second.request.mockReturnValue(nextServerRoot.promise);
  const props = panelProps();
  const view = render(first.wrap(<WorkspacePanel {...props} />));
  fireEvent.click(await screen.findByRole("button", { name: "Choose directory" }));
  view.rerender(first.wrap(<WorkspacePanel {...props} canvasId="canvas-b" />));
  expect(screen.getByTestId("files").dataset.root).toBe("~");
  expect(screen.getByTestId("files").dataset.workspace).toBe("");
  await act(async () => {
    nextCanvasRoot.resolve({ path: "/beta/canvas-b/shared" });
    await nextCanvasRoot.promise;
  });
  await act(async () => {
    oldRoot.resolve({ path: "/beta/canvas-a/shared" });
    await oldRoot.promise;
  });
  expect(screen.getByTestId("files").dataset.workspace).toBe("/beta/canvas-b/shared");
  fireEvent.click(screen.getByRole("button", { name: "Choose directory" }));
  view.rerender(second.wrap(<WorkspacePanel {...props} canvasId="canvas-b" />));
  expect(screen.getByTestId("files").dataset.root).toBe("~");
  expect(screen.getByTestId("files").dataset.workspace).toBe("");
  await act(async () => {
    nextServerRoot.resolve({ path: "/another/canvas-b/shared" });
    await nextServerRoot.promise;
  });
  expect(screen.getByTestId("files").dataset.workspace).toBe("/another/canvas-b/shared");
});

it("retains the canvas workspace as the terminal default but honors explicit file navigation", async () => {
  const remote = host("beta");
  remote.request.mockResolvedValue({ path: "/beta/canvas-a/shared" });
  const props = panelProps();
  const view = render(remote.wrap(<WorkspacePanel {...props} mode="terminal" />));
  expect((await screen.findByTestId("terminal")).dataset.cwd).toBe("/beta/canvas-a/shared");
  view.rerender(remote.wrap(<WorkspacePanel {...props} />));
  fireEvent.click(await screen.findByRole("button", { name: "Choose home" }));
  await waitFor(() => expect(screen.getByTestId("terminal").dataset.cwd).toBe("~"));
});
