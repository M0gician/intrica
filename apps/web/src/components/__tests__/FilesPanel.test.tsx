import type { ServerInfo } from "@intrica/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionServices, createSessionConnection } from "../../api/connection";
import type { DirectoryListing, FileContent } from "../../api/workspace";
import { ConnectionContext } from "../../app/connection-context";
import type { ServerActions } from "../../app/preferences";
import { FilesPanel } from "../FilesPanel";

vi.mock("../DocumentEditor", () => ({ DocumentEditor: () => <div>Document preview</div> }));
vi.mock("../PdfPreview", () => ({
  isPdfPath: (path: string) => /\.pdf$/i.test(path),
  PdfPreview: () => <div>PDF preview</div>,
}));

afterEach(cleanup);

const listing: DirectoryListing = {
  name: "shared",
  path: "/srv/workspace/shared",
  parent: "/srv/workspace",
  entries: [{ name: "report.txt", path: "/srv/workspace/shared/report.txt", type: "file" }],
  truncated: false,
};
function host(id: string, label: string, baseUrl = `http://${id}:3001`, local = false) {
  const connection = createSessionConnection(baseUrl, id, `binding-${id}`);
  const request = vi.fn().mockResolvedValue(listing);
  const server: ServerInfo = {
    id,
    name: `Intrica on ${id}`,
    version: "0.2.5",
    apiVersion: "v2",
    graphProtocol: 1,
    web: { enabled: true },
  };
  const servers: ServerActions = {
    profiles: [{ id, label, baseUrl, local }],
    activeId: id,
    desktop: true,
    connect: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
  };
  const wrap = (children: ReactNode) => (
    <ConnectionServices.Provider value={{ ...connection, serverRequest: request }}>
      <ConnectionContext.Provider
        value={{ server, address: baseUrl, servers, capabilities: null, nativeBrowser: false }}
      >
        {children}
      </ConnectionContext.Provider>
    </ConnectionServices.Provider>
  );
  return { connection, request, servers, wrap };
}

it("keeps navigation compact and discloses the server, real address and path on demand", async () => {
  const remote = host("beta", "Build server with a long human-readable label");
  render(remote.wrap(<FilesPanel root="/srv/workspace/shared" onRoot={vi.fn()} onAdd={vi.fn()} />));
  await screen.findByRole("button", { name: "report.txt" });
  const trigger = screen.getByRole("button", { name: "查看文件位置" });
  expect(trigger.textContent).toBe("");
  expect(trigger.title).toBe("文件来源：Build server with a long human-readable label");
  expect(screen.queryByText("http://beta:3001")).toBeNull();
  expect(document.querySelector(".execution-target")).toBeNull();
  trigger.focus();
  // Native keyboard activation dispatches a click with no pointer detail.
  fireEvent.click(trigger, { detail: 0 });
  const dialog = await screen.findByRole("dialog", { name: "文件位置" });
  expect(within(dialog).getByText("Build server with a long human-readable label")).toBeTruthy();
  expect(within(dialog).getByText("http://beta:3001")).toBeTruthy();
  expect(within(dialog).getByText("/srv/workspace/shared")).toBeTruthy();
  expect(within(dialog).getByText("当前目录")).toBeTruthy();
  expect(dialog.textContent).not.toMatch(/本机|此设备/);
  expect(remote.servers.connect).not.toHaveBeenCalled();
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("shows a file's server path in preview and names this device only as the download destination", async () => {
  const remote = host("beta", "beta");
  const file: FileContent = {
    path: "/srv/workspace/shared/report.txt",
    name: "report.txt",
    mime: "text/plain",
    text: "report",
  };
  remote.request.mockImplementation(async (path: string) =>
    path.startsWith("files?") ? listing : file,
  );
  render(remote.wrap(<FilesPanel root={listing.path} onRoot={vi.fn()} onAdd={vi.fn()} />));
  fireEvent.click(await screen.findByRole("button", { name: "report.txt" }));
  await screen.findByRole("button", { name: "下载到此设备" });
  fireEvent.click(screen.getByRole("button", { name: "查看文件位置" }));
  const dialog = await screen.findByRole("dialog", { name: "文件位置" });
  expect(within(dialog).getByText("文件路径")).toBeTruthy();
  expect(within(dialog).getByText(file.path)).toBeTruthy();
  expect(dialog.textContent).not.toContain("此设备");
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭文件位置" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("dismisses source details and ignores a stale file response when switching servers at the same path", async () => {
  const oldHost = host("old", "Old server");
  const newHost = host("new", "New server");
  let finishFile!: (file: FileContent) => void;
  const pendingFile = new Promise<FileContent>((resolve) => {
    finishFile = resolve;
  });
  oldHost.request.mockImplementation((path: string) =>
    path.startsWith("files?") ? Promise.resolve(listing) : pendingFile,
  );
  newHost.request.mockResolvedValue({ ...listing, entries: [] });
  const panel = <FilesPanel root={listing.path} onRoot={vi.fn()} onAdd={vi.fn()} />;
  const view = render(oldHost.wrap(panel));
  fireEvent.click(await screen.findByRole("button", { name: "report.txt" }));
  fireEvent.click(screen.getByRole("button", { name: "查看文件位置" }));
  await screen.findByRole("dialog", { name: "文件位置" });
  view.rerender(newHost.wrap(panel));
  await screen.findByText("空目录");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "查看文件位置" }).title).toBe("文件来源：New server");
  await act(async () => {
    finishFile({ name: "report.txt", path: listing.entries[0]!.path, mime: "text/plain" });
    await pendingFile;
  });
  expect(screen.queryByText("Document preview")).toBeNull();
  expect(document.body.textContent).not.toContain("Old server");
  fireEvent.click(screen.getByRole("button", { name: "查看文件位置" }));
  expect(within(await screen.findByRole("dialog")).getByText("http://new:3001")).toBeTruthy();
});

it("labels a local server only from its explicit profile, never from a loopback address", async () => {
  const tunnel = host("tunnel", "Remote via SSH", "http://127.0.0.1:43123");
  const panel = <FilesPanel root={listing.path} onRoot={vi.fn()} onAdd={vi.fn()} />;
  const view = render(tunnel.wrap(panel));
  await screen.findByRole("button", { name: "report.txt" });
  expect(screen.getByRole("button", { name: "查看文件位置" }).title).toBe(
    "文件来源：Remote via SSH",
  );
  const local = host("local", "Internal label", "http://127.0.0.1:3001", true);
  view.rerender(local.wrap(panel));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "查看文件位置" }).title).toBe(
      "文件来源：内置本地服务器",
    ),
  );
});

it("resolves the home directory on the server and exposes the shared canvas directory without claiming all Agent files live there", async () => {
  const remote = host("beta", "beta");
  remote.request.mockResolvedValue({ ...listing, name: "reviewer", path: "/home/reviewer" });
  const onRoot = vi.fn();
  render(
    remote.wrap(
      <FilesPanel root="~" workspacePath={listing.path} onRoot={onRoot} onAdd={vi.fn()} />,
    ),
  );
  await waitFor(() => expect(remote.request).toHaveBeenCalled());
  expect(remote.request.mock.calls[0]![0]).toBe("files?path=~&search=");
  const location = screen.getByRole("button", { name: "输入目录路径" });
  await waitFor(() => expect(location.title).toBe("/home/reviewer"));
  expect(location.textContent).toBe("用户主目录");
  fireEvent.click(screen.getByRole("button", { name: "查看文件位置" }));
  const dialog = await screen.findByRole("dialog", { name: "文件位置" });
  expect(within(dialog).getByText("服务器账户的主目录")).toBeTruthy();
  expect(
    within(dialog).getByText("当前画布的共享目录，Agent 可能使用各自的工作目录。"),
  ).toBeTruthy();
  expect(within(dialog).getByText(listing.path)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "画布工作目录" }));
  expect(onRoot).toHaveBeenCalledWith(listing.path);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "查看文件位置" }));
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "用户主目录",
    }),
  );
  expect(onRoot).toHaveBeenLastCalledWith("~");
});

it("dismisses the portalled location details when the files pane becomes inactive", async () => {
  const remote = host("beta", "beta");
  const props = { root: listing.path, onRoot: vi.fn(), onAdd: vi.fn() };
  const view = render(remote.wrap(<FilesPanel {...props} active />));
  fireEvent.click(screen.getByRole("button", { name: "查看文件位置" }));
  await screen.findByRole("dialog", { name: "文件位置" });
  view.rerender(remote.wrap(<FilesPanel {...props} active={false} />));
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(remote.wrap(<FilesPanel {...props} active />));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("cancels a late file read when navigating to the current directory again", async () => {
  const remote = host("beta", "beta");
  let finishFile!: (value: FileContent) => void;
  const pendingFile = new Promise<FileContent>((resolve) => {
    finishFile = resolve;
  });
  remote.request.mockImplementation((path: string) =>
    path.startsWith("files?") ? Promise.resolve(listing) : pendingFile,
  );
  const onRoot = vi.fn();
  render(remote.wrap(<FilesPanel root="~" onRoot={onRoot} onAdd={vi.fn()} />));
  fireEvent.click(await screen.findByRole("button", { name: "report.txt" }));
  const fileCall = remote.request.mock.calls.find((args) => String(args[0]).startsWith("file?"))!;
  fireEvent.click(screen.getByRole("button", { name: "查看文件位置" }));
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: "用户主目录" }),
  );
  expect(onRoot).toHaveBeenCalledWith("~");
  expect((fileCall[3] as AbortSignal).aborted).toBe(true);
  await act(async () => {
    finishFile({ path: listing.entries[0]!.path, name: "report.txt", mime: "text/plain" });
    await pendingFile;
  });
  expect(screen.queryByText("Document preview")).toBeNull();
});

it("consumes direct file targets once so a dismissed preview stays closed after switching tools", async () => {
  const remote = host("beta", "beta");
  const props = {
    root: listing.path,
    openFileTarget: { path: "/srv/workspace/shared/report.pdf", nonce: "open-1" },
    onRoot: vi.fn(),
    onAdd: vi.fn(),
  };
  const view = render(remote.wrap(<FilesPanel {...props} active />));
  await screen.findByText("PDF preview");
  fireEvent.click(screen.getByRole("button", { name: "关闭文件预览" }));
  expect(screen.queryByText("PDF preview")).toBeNull();
  view.rerender(remote.wrap(<FilesPanel {...props} active={false} />));
  view.rerender(remote.wrap(<FilesPanel {...props} active />));
  expect(screen.queryByText("PDF preview")).toBeNull();
  view.rerender(
    remote.wrap(
      <FilesPanel {...props} openFileTarget={{ ...props.openFileTarget, nonce: "open-2" }} />,
    ),
  );
  await screen.findByText("PDF preview");
});

it.each(["txt", "pdf"])(
  "opens a direct %s target after StrictMode replays mount effects, without reopening a dismissed preview",
  async (extension) => {
    const remote = host("beta", "beta");
    const path = `/srv/workspace/shared/report.${extension}`;
    remote.request.mockImplementation(async (endpoint: string) =>
      endpoint.startsWith("files?")
        ? listing
        : {
            path,
            name: `report.${extension}`,
            mime: "text/plain",
            text: "report",
          },
    );
    const props = {
      root: listing.path,
      openFileTarget: { path, nonce: "strict-open-1" },
      onRoot: vi.fn(),
      onAdd: vi.fn(),
    };
    const panel = (active: boolean) => (
      <StrictMode>{remote.wrap(<FilesPanel {...props} active={active} />)}</StrictMode>
    );
    const view = render(panel(true));
    const preview = extension === "pdf" ? "PDF preview" : "Document preview";
    await screen.findByText(preview);
    fireEvent.click(screen.getByRole("button", { name: "关闭文件预览" }));
    view.rerender(panel(false));
    view.rerender(panel(true));
    expect(screen.queryByText(preview)).toBeNull();
  },
);

it("focuses the path editor and preserves a draft when a delayed directory result arrives", async () => {
  const remote = host("beta", "beta");
  let finishListing!: (value: DirectoryListing) => void;
  const pendingListing = new Promise<DirectoryListing>((resolve) => {
    finishListing = resolve;
  });
  remote.request.mockReturnValue(pendingListing);
  render(remote.wrap(<FilesPanel root="~" onRoot={vi.fn()} onAdd={vi.fn()} />));
  await waitFor(() => expect(remote.request).toHaveBeenCalled());
  const trigger = screen.getByRole("button", { name: "输入目录路径" });
  fireEvent.click(trigger);
  const input = screen.getByRole("textbox", { name: "服务器目录路径" }) as HTMLInputElement;
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "/draft/new-directory" } });
  await act(async () => {
    finishListing(listing);
    await pendingListing;
  });
  expect(input.value).toBe("/draft/new-directory");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: "服务器目录路径" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
