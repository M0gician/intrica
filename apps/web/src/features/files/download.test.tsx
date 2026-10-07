import type { FileDownloadProgress } from "@intrica/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionServices, createSessionConnection } from "../../api/connection";
import { DownloadStatus, useFileDownload } from "./download";

afterEach(() => {
  cleanup();
  delete window.intricaDesktop;
  vi.restoreAllMocks();
});
function Fixture() {
  const download = useFileDownload();
  return (
    <>
      <button
        type="button"
        disabled={download.busy}
        onClick={() => void download.start({ path: "/srv/report.pdf", name: "report.pdf" })}
      >
        Save
      </button>
      <DownloadStatus download={download} />
    </>
  );
}

it("shows native byte progress and destination, disables duplicate saves, and reveals only the completed ID", async () => {
  let finish!: (result: { cancelled: boolean; path: string }) => void;
  const save = vi.fn(
    (_input: unknown) =>
      new Promise<{ cancelled: boolean; path: string }>((resolve) => {
        finish = resolve;
      }),
  );
  const reveal = vi.fn(),
    cancel = vi.fn();
  const state = vi.fn(
    async (id: string): Promise<FileDownloadProgress> => ({
      id,
      phase: "downloading",
      downloadedBytes: 1024,
      totalBytes: 4096,
      targetPath: "/Downloads/report.pdf",
      startedAt: Date.now() - 1000,
    }),
  );
  window.intricaDesktop = { files: { save, reveal, cancel, state } } as any;
  const connection = createSessionConnection("", "beta", "binding-beta");
  render(
    <ConnectionServices.Provider value={connection}>
      <Fixture />
    </ConnectionServices.Provider>,
  );
  fireEvent.click(screen.getByText("Save"));
  expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText("Save"));
  await waitFor(() => expect(screen.getByRole("progressbar").getAttribute("value")).toBe("1024"));
  expect(screen.getByText("/Downloads/report.pdf")).toBeTruthy();
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0]?.[0]).toMatchObject({
    path: "/srv/report.pdf",
    bindingId: "binding-beta",
  });
  await act(async () => finish({ cancelled: false, path: "/Downloads/report.pdf" }));
  fireEvent.click(screen.getByText("在文件管理器中显示"));
  expect(reveal).toHaveBeenCalledWith((save.mock.calls[0] as any)[0].id);
  expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(false);
});

it("cancels on connection disposal and never displays a late completion from the old server", async () => {
  let finish!: (result: { cancelled: boolean; path: string }) => void;
  const cancel = vi.fn(async () => {});
  window.intricaDesktop = {
    files: {
      save: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
      cancel,
    },
  } as any;
  const old = createSessionConnection("", "a", "a"),
    next = createSessionConnection("", "b", "b");
  const { rerender } = render(
    <ConnectionServices.Provider value={old}>
      <Fixture />
    </ConnectionServices.Provider>,
  );
  fireEvent.click(screen.getByText("Save"));
  const finishOld = finish;
  act(() => old.dispose());
  rerender(
    <ConnectionServices.Provider value={next}>
      <Fixture />
    </ConnectionServices.Provider>,
  );
  expect(cancel).toHaveBeenCalled();
  fireEvent.click(screen.getByText("Save"));
  expect(window.intricaDesktop!.files!.save).toHaveBeenCalledTimes(2);
  await act(async () => finishOld({ cancelled: false, path: "/old-server-download" }));
  expect(screen.queryByText("/old-server-download")).toBeNull();
});

it("browser handoff reports browser ownership instead of pretending to know native completion or destination", async () => {
  const connection = createSessionConnection("", "web");
  connection.transport.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  render(
    <ConnectionServices.Provider value={connection}>
      <Fixture />
    </ConnectionServices.Provider>,
  );
  fireEvent.click(screen.getByText("Save"));
  await screen.findByText("已交给浏览器下载，请在浏览器下载列表查看进度和保存位置。");
  expect(click).toHaveBeenCalledOnce();
  expect(screen.queryByText("在文件管理器中显示")).toBeNull();
});
