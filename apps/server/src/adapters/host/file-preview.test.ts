import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_PREVIEW_TYPES } from "@intrica/contracts";
import sharp from "sharp";
import { expect, it } from "vitest";
import { MAX_TEXT_PREVIEW, previewBytes, readFilePreview, sniffMime } from "./file-preview.js";

it("covers every declared type with content detection and preserves original image bytes", async () => {
  for (const type of FILE_PREVIEW_TYPES) {
    let data: Buffer;
    if (type.kind === "image") {
      data =
        type.mime === "image/svg+xml"
          ? Buffer.from(
              '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="red"/></svg>',
            )
          : await sharp({ create: { width: 4, height: 3, channels: 3, background: "#abcdef" } })
              .toFormat(type.mime.slice(6) as "png" | "jpeg" | "webp" | "gif")
              .toBuffer();
    } else
      data = Buffer.from(
        type.kind === "pdf"
          ? "%PDF-1.7\n"
          : type.mime === "text/html"
            ? "<article>Unicode: λ 中文</article>"
            : "# Evidence\nUnicode: λ 中文\n",
      );
    for (const name of ["测试 space", "wrong.bin", `document.${type.extensions[0] ?? "txt"}`]) {
      const result = await previewBytes(data, name);
      expect(result.previewError).toBeUndefined();
      const expected =
        type.mime === "text/markdown" && !name.endsWith(".md") ? "text/plain" : type.mime;
      expect(result.mime).toBe(expected);
      if (type.kind === "image") expect(Buffer.from(result.data!, "base64")).toEqual(data);
      if (type.mime.startsWith("text/")) expect(result.text).toBe(data.toString());
    }
  }
});

it("reports binary, corrupt and excessive content without attempting unbounded decoding", async () => {
  expect(await previewBytes(Buffer.from([0, 1, 255]), "picture.png")).toMatchObject({
    previewError: "unsupported",
  });
  expect(await previewBytes(Buffer.from("GIF89a-broken"), "plain.txt")).toMatchObject({
    mime: "image/gif",
    previewError: "corrupt",
  });
  expect(await previewBytes(Buffer.alloc(MAX_TEXT_PREVIEW + 1, 65), "large.txt")).toMatchObject({
    previewError: "too_large",
  });
  const split = Buffer.from(`${"a".repeat(8191)}中`).subarray(0, 8192);
  expect(sniffMime(split, "text", true)).toBe("text/plain");
});

it("reads actual files, rejects symbolic links and missing paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "file-preview-"));
  try {
    const path = join(dir, "空 格");
    await writeFile(path, "αβγ");
    expect(await readFilePreview(path)).toMatchObject({ text: "αβγ", size: 6 });
    await symlink(path, join(dir, "link"));
    await expect(readFilePreview(join(dir, "link"))).rejects.toThrow();
    await expect(readFilePreview(join(dir, "absent"))).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
