import { describe, expect, it, vi } from "vitest";
import { droppedText, filesToEntries, isPdfFile, localImportEntry, readTextFile } from "../imports";
import { safeWebUrl } from "../web-url";

describe("workspace imports", () => {
  it("recognizes PDF uploads even when the browser provides no MIME type", () => {
    expect(isPdfFile(new File(["%PDF-1.7"], "Report.PDF"))).toBe(true);
    expect(isPdfFile(new File(["%PDF-1.7"], "download", { type: "application/pdf" }))).toBe(true);
    expect(isPdfFile(new File(["text"], "notes.txt"))).toBe(false);
  });
  it("adds a server PDF as a live file reference without reading or re-uploading all bytes", async () => {
    const request = vi.fn();
    const item = await localImportEntry(
      { name: "Report.pdf", path: "/server/Report.pdf", type: "file" },
      request,
    );
    expect(item.resource).toEqual({ type: "file", path: "/server/Report.pdf" });
    expect(item.file).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
  it("checks the node text limit before any batch writes", async () => {
    const file = {
      name: "large.md",
      type: "text/markdown",
      size: 50001,
      arrayBuffer: async () => new TextEncoder().encode("a".repeat(50001)).buffer,
    } as File;
    await expect(readTextFile(file)).rejects.toThrow("50,000");
  });
  it("does not recursively import directory picker contents", () => {
    const file = new File(["content"], "a.md");
    Object.defineProperty(file, "webkitRelativePath", { value: "资料/a.md" });
    expect(() => filesToEntries([file])).toThrow("目录会作为一个对象保存");
  });
  it("rejects an over-limit batch before it can be imported", () => {
    expect(() =>
      filesToEntries(Array.from({ length: 101 }, (_, i) => new File([""], `${i}.txt`))),
    ).toThrow("100");
  });
  it("only permits HTTP/HTTPS addresses without embedded credentials", () => {
    for (const url of [
      "javascript:alert(1)",
      "ghttps://example.com",
      "data:text/html,hello",
      "https://user:password@example.com",
    ])
      expect(safeWebUrl(url)).toBeNull();
    expect(safeWebUrl("https://example.com/path")).toBe("https://example.com/path");
  });
  it("keeps excerpt text with a source URL and never imports HTML as executable content", () => {
    const values: Record<string, string> = {
      "text/html": "<b>证据</b>",
      "text/uri-list": "# Source\nhttps://example.com/source",
    };
    const result = droppedText({ getData: (type: string) => values[type] ?? "" } as DataTransfer);
    expect(result?.text).toBe("证据\n\n来源：https://example.com/source");
  });
  it("extracts a web image address for upload with a retained link fallback", () => {
    const result = droppedText({
      getData: (type: string) =>
        type === "text/html" ? '<img src="https://example.com/image.png" alt="证据图">' : "",
    } as DataTransfer);
    expect(result).toEqual({
      imageUrl: "https://example.com/image.png",
      title: "证据图",
      text: "https://example.com/image.png",
    });
  });
});
