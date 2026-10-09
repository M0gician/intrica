import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionServices, createSessionConnection } from "../../api/connection";
import { FilesPanel } from "../FilesPanel";
import { PdfPreview } from "../PdfPreview";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
const firstPage = {
  page: 1,
  pageCount: 2,
  nextPage: 2,
  text: "First page evidence",
  hasText: true,
  image: "aW1hZ2U=",
  width: 600,
  height: 800,
  totalChars: 19,
  nextCharOffset: null,
};
const secondPage = {
  ...firstPage,
  page: 2,
  nextPage: null,
  text: "",
  hasText: false,
  totalChars: 0,
};
function connection(id = "server-a") {
  const value = createSessionConnection(`http://${id}.example`, id, id);
  const request = vi.fn().mockResolvedValue(firstPage);
  value.transport.request = request;
  return { value, request };
}

it("renders uploaded PDFs as PNG pages with navigation, extracted text and an explicit no-OCR notice", async () => {
  const { value, request } = connection();
  request.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage);
  render(
    <ConnectionServices.Provider value={value}>
      <PdfPreview nodeId="pdf-node" title="Report" />
    </ConnectionServices.Provider>,
  );
  expect(screen.getByRole("region", { name: "PDF 预览" })).toBeTruthy();
  await screen.findByText("第 1 / 2 页");
  expect(request).toHaveBeenCalledWith(
    "/api/v2/nodes/pdf-node/pdf?page=1&render=true&characterOffset=0&characterLimit=12000",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(screen.getByRole("img").getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U=");
  expect(screen.getByText("First page evidence")).toBeTruthy();
  expect((screen.getByRole("button", { name: "上一页" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText("第 2 / 2 页");
  expect(screen.queryByText("First page evidence")).toBeNull();
  expect(screen.getByText("此页没有可提取文本；请检查页面图像（未执行 OCR）。")).toBeTruthy();
  expect((screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement).disabled).toBe(true);
});

it("encodes server file paths, uses the current connection and does not embed raw PDF bytes", async () => {
  const { value, request } = connection();
  render(
    <ConnectionServices.Provider value={value}>
      <PdfPreview path="/资料/A&B report.pdf" />
    </ConnectionServices.Provider>,
  );
  await screen.findByRole("img");
  expect(request).toHaveBeenCalledWith(
    `/api/v2/workspace/pdf?path=${encodeURIComponent("/资料/A&B report.pdf")}&page=1&render=true&characterOffset=0&characterLimit=12000`,
    expect.any(Object),
  );
  expect(document.querySelector("iframe, object, embed")).toBeNull();
  expect(document.querySelector('img[src^="data:application/pdf"]')).toBeNull();
});

it("the files panel previews server PDFs without downloading binary file content or showing image-copy controls", async () => {
  const { value, request } = connection();
  const files = vi.fn().mockImplementation(async (url: string) =>
    url.startsWith("file?")
      ? {
          name: "Reference.pdf",
          path: "/docs/Reference.pdf",
          mime: "application/pdf",
          serverId: value.serverId,
        }
      : { name: "docs", path: "/docs", parent: "/", entries: [], truncated: false },
  );
  value.serverRequest = files;
  render(
    <ConnectionServices.Provider value={value}>
      <FilesPanel
        root="/docs"
        onRoot={vi.fn()}
        onAdd={vi.fn()}
        openFileTarget={{ path: "/docs/Reference.pdf", nonce: "open" }}
      />
    </ConnectionServices.Provider>,
  );
  await screen.findByRole("region", { name: "PDF 预览" });
  await screen.findByText("第 1 / 2 页");
  expect(request).toHaveBeenCalledWith(
    expect.stringContaining("/api/v2/workspace/pdf?path="),
    expect.any(Object),
  );
  expect(files.mock.calls.some(([url]) => String(url).startsWith("file?"))).toBe(true);
  expect(screen.queryByRole("button", { name: "复制图片" })).toBeNull();
  expect(document.querySelector('img[src^="data:application/pdf"]')).toBeNull();
});

it("a same-path switch to another server immediately clears the old page and ignores its late response", async () => {
  const a = connection(),
    b = connection("server-b");
  let resolveA!: (value: typeof firstPage) => void;
  let resolveB!: (value: typeof firstPage) => void;
  a.request.mockReturnValue(
    new Promise((resolve) => {
      resolveA = resolve;
    }),
  );
  b.request.mockReturnValue(
    new Promise((resolve) => {
      resolveB = resolve;
    }),
  );
  const view = render(
    <ConnectionServices.Provider value={a.value}>
      <PdfPreview path="/same.pdf" />
    </ConnectionServices.Provider>,
  );
  await waitFor(() => expect(a.request).toHaveBeenCalledTimes(1));
  view.rerender(
    <ConnectionServices.Provider value={b.value}>
      <PdfPreview path="/same.pdf" />
    </ConnectionServices.Provider>,
  );
  expect(a.request.mock.calls[0]![1].signal.aborted).toBe(true);
  await act(async () => {
    resolveA({ ...firstPage, text: "Server A secret" });
  });
  expect(screen.queryByText("Server A secret")).toBeNull();
  await act(async () => {
    resolveB({ ...firstPage, text: "Server B evidence" });
  });
  expect(screen.getByText("Server B evidence")).toBeTruthy();
});

it("disposal aborts an in-flight request and suppresses a late transport response", async () => {
  const { value, request } = connection();
  let resolve!: (value: typeof firstPage) => void;
  request.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render(
    <ConnectionServices.Provider value={value}>
      <PdfPreview nodeId="doc" />
    </ConnectionServices.Provider>,
  );
  value.dispose();
  await act(async () => {
    resolve(firstPage);
  });
  expect(request.mock.calls[0]![1].signal.aborted).toBe(true);
  expect(screen.queryByText("First page evidence")).toBeNull();
});

it("shows recoverable page errors and never substitutes a wrong page as a successful result", async () => {
  const { value, request } = connection();
  request
    .mockRejectedValueOnce(new Error("PDF is encrypted"))
    .mockResolvedValueOnce({ ...firstPage, page: 2 })
    .mockResolvedValueOnce(firstPage);
  render(
    <ConnectionServices.Provider value={value}>
      <PdfPreview nodeId="doc" />
    </ConnectionServices.Provider>,
  );
  await screen.findByText("PDF is encrypted");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText("PDF 页面数据无效");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText("第 1 / 2 页");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("bounds zoom, fits width and discloses incomplete text without claiming OCR or complete review", async () => {
  const { value, request } = connection();
  request.mockResolvedValue({ ...firstPage, totalChars: 1000, nextCharOffset: 19 });
  render(
    <ConnectionServices.Provider value={value}>
      <PdfPreview nodeId="doc" />
    </ConnectionServices.Provider>,
  );
  await screen.findByRole("button", { name: "继续加载本页文本" });
  for (let i = 0; i < 12; i++) fireEvent.click(screen.getByRole("button", { name: "放大 PDF" }));
  expect(screen.getByRole("img").style.width).toBe("300%");
  fireEvent.click(screen.getByRole("button", { name: "适应宽度" }));
  expect(screen.getByRole("img").style.width).toBe("100%");
  fireEvent.error(screen.getByRole("img"));
  expect(screen.getByText("PDF 页面图像暂不可用")).toBeTruthy();
  expect(screen.getByText("First page evidence")).toBeTruthy();
});

it("recovers render limits through text-only without making download depend on parsing", async () => {
  const { value, request } = connection();
  request
    .mockRejectedValueOnce(
      Object.assign(new Error("Localized validation"), {
        serverMessage: "Unable to read PDF: Image exceeded maximum allowed size",
      }),
    )
    .mockResolvedValueOnce({ ...firstPage, image: undefined });
  const download = vi.fn();
  render(
    <ConnectionServices.Provider value={value}>
      <PdfPreview nodeId="doc" onDownload={download} />
    </ConnectionServices.Provider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "下载原文件" }));
  expect(download).toHaveBeenCalledTimes(1);
  await screen.findByText("PDF 超出处理限制。可尝试仅提取文本，或下载原文件后拆分文档。");
  fireEvent.click(screen.getByRole("button", { name: "仅提取文本" }));
  await screen.findByText("First page evidence");
  expect(request.mock.calls[1]![0]).toContain("render=false");
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText("可提取文本").closest("details")?.open).toBe(true);
});

it("continues a long page without losing its image or duplicating text", async () => {
  const { value, request } = connection();
  request
    .mockResolvedValueOnce({ ...firstPage, text: "first ", nextCharOffset: 6 })
    .mockResolvedValueOnce({
      ...firstPage,
      text: "second",
      image: undefined,
      nextCharOffset: null,
    });
  render(
    <ConnectionServices.Provider value={value}>
      <PdfPreview nodeId="doc" />
    </ConnectionServices.Provider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "继续加载本页文本" }));
  await screen.findByText("first second");
  expect(request.mock.calls[1]![0]).toContain("render=false&characterOffset=6");
  expect(screen.getByRole("img")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "继续加载本页文本" })).toBeNull();
});

it("jump and reading position survive remount and reconnect, but never cross servers", async () => {
  const { value, request } = connection();
  request.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage);
  const view = render(
    <ConnectionServices.Provider value={value}>
      <PdfPreview nodeId="doc" />
    </ConnectionServices.Provider>,
  );
  await screen.findByText("第 1 / 2 页");
  fireEvent.change(screen.getByRole("spinbutton", { name: "PDF 页码" }), {
    target: { value: "2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "跳转" }));
  await screen.findByText("第 2 / 2 页");
  view.unmount();
  const same = connection();
  same.request.mockResolvedValue(secondPage);
  const next = render(
    <ConnectionServices.Provider value={same.value}>
      <PdfPreview nodeId="doc" />
    </ConnectionServices.Provider>,
  );
  await screen.findByText("第 2 / 2 页");
  expect(same.request.mock.calls[0]![0]).toContain("page=2");
  const other = connection("server-b");
  next.rerender(
    <ConnectionServices.Provider value={other.value}>
      <PdfPreview nodeId="doc" />
    </ConnectionServices.Provider>,
  );
  await screen.findByText("第 1 / 2 页");
  expect(other.request.mock.calls[0]![0]).toContain("page=1");
});

it("retries a failed continuation without appending the successful prefix twice", async () => {
  const { value, request } = connection();
  request
    .mockResolvedValueOnce({ ...firstPage, text: "prefix ", nextCharOffset: 7 })
    .mockRejectedValueOnce(new Error("disconnected"))
    .mockResolvedValueOnce({ ...firstPage, text: "suffix", image: undefined });
  render(
    <ConnectionServices.Provider value={value}>
      <PdfPreview nodeId="doc" />
    </ConnectionServices.Provider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "继续加载本页文本" }));
  await screen.findByRole("alert");
  expect(screen.getByText("prefix")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText("prefix suffix");
});

it.each([
  [{ code: "LIMIT_REACHED", message: "Busy" }, "PDF 处理暂时繁忙，请稍后重试。"],
  [
    { serverMessage: "PDF is encrypted; unlock it before importing", message: "Validation" },
    "此 PDF 已加密，请先在此设备上解锁，再上传或替换原文件。",
  ],
  [
    { serverMessage: "Invalid PDF structure", message: "Validation" },
    "PDF 文件结构损坏或不受支持，请下载原文件检查。",
  ],
])("explains only explicit failure causes %#", async (error, message) => {
  const { value, request } = connection();
  request.mockRejectedValue(error);
  render(
    <ConnectionServices.Provider value={value}>
      <PdfPreview nodeId="doc" />
    </ConnectionServices.Provider>,
  );
  await screen.findByText(message);
});
