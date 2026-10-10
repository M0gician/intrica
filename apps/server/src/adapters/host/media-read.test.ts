import { randomBytes } from "node:crypto";
import { mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { afterAll, beforeAll, expect, test } from "vitest";
import { readMedia } from "./media-read.js";

let directory: string;
let sequence = 0;
let png: Buffer;

const signal = () => new AbortController().signal;
const save = async (bytes: Buffer | string, suffix = "") => {
  const path = join(directory, `media-${++sequence}${suffix}`);
  await writeFile(path, bytes);
  return path;
};
const generated = (width = 16, height = 12) =>
  sharp({ create: { width, height, channels: 3, background: "#d12e43" } });

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "intrica-media-read-"));
  png = await generated().png().toBuffer();
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

test.each(["png", "jpeg", "webp"] as const)(
  "decodes real %s bytes and returns an actual bounded PNG image",
  async (format) => {
    const path = await save(await generated().toFormat(format).toBuffer(), `.${format}`);
    const output = await readMedia({ path }, signal(), true);
    expect(output?.details).toMatchObject({
      mediaType: "image",
      format,
      width: 16,
      height: 12,
      previewWidth: 16,
      previewHeight: 12,
      frame: 0,
      frames: 1,
    });
    expect(output?.content[0]).toEqual({ type: "text", text: expect.any(String) });
    const summary = JSON.parse((output!.content[0] as { text: string }).text);
    expect(summary.path).toBe(path);
    expect(summary.note).toContain("animation playback is not verified");
    const image = output!.content[1];
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    if (image?.type !== "image") throw new Error("Missing image content");
    const decoded = await sharp(Buffer.from(image.data, "base64")).metadata();
    expect(decoded).toMatchObject({ format: "png", width: 16, height: 12 });
  },
);

test.each(["", ".txt", ".jpeg"])(
  "uses bytes rather than the %j filename suffix to identify PNG",
  async (suffix) => {
    const path = await save(png, suffix);
    expect((await readMedia({ path, mode: "auto" }, signal(), true))?.details.format).toBe("png");
  },
);

test("returns undefined for ordinary text even with a misleading image extension", async () => {
  const path = await save("# Ordinary UTF-8 text\n这是文字。\n", ".png");
  await expect(readMedia({ path }, signal(), true)).resolves.toBeUndefined();
  await expect(readMedia({ path }, signal(), false)).resolves.toBeUndefined();
  await expect(
    readMedia({ path, mode: "text", offset: 1, limit: 2 }, signal(), false),
  ).resolves.toBeUndefined();
  await expect(readMedia({ path, frame: 0 }, signal(), true)).rejects.toMatchObject({
    code: "VALIDATION",
    message: expect.stringContaining("非图片"),
  });
});

test("text mode returns media metadata without decoding binary as text or sending images", async () => {
  const path = await save(png);
  const output = await readMedia({ path, mode: "text", frame: 0 }, signal(), false);
  expect(output?.details).toMatchObject({
    mediaType: "image",
    capabilities: { text: false, frames: true },
  });
  expect(output?.content.every((p) => p.type === "text")).toBe(true);
});

test.each(["auto", "image"] as const)(
  "does not return image content to a text-only model in %s mode",
  async (mode) => {
    const path = await save(png);
    await expect(readMedia({ path, mode }, signal(), false)).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("不支持图像"),
    });
  },
);

test("reads distinct GIF still frames and rejects frame boundaries", async () => {
  const path = await save(
    Buffer.from(
      "R0lGODlhAQABAIAAAExpcf8AACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFCgAAACwAAAAAAQABAAACAkwBACH5BAUKAAAALAAAAAABAAEAgExpcQD/AAICTAEAOw==",
      "base64",
    ),
  );
  const first = await readMedia({ path }, signal(), true);
  const last = await readMedia({ path, frame: 1 }, signal(), true);
  expect(first?.details).toMatchObject({ format: "gif", frame: 0, frames: 2, width: 1, height: 1 });
  expect(last?.details).toMatchObject({ format: "gif", frame: 1, frames: 2, width: 1, height: 1 });
  expect(last?.content[1]).not.toEqual(first?.content[1]);
  await expect(readMedia({ path, frame: 2 }, signal(), true)).rejects.toMatchObject({
    code: "VALIDATION",
    message: expect.stringContaining("共 2 帧"),
  });
  await expect(readMedia({ path, frame: -1 }, signal(), true)).rejects.toMatchObject({
    code: "VALIDATION",
  });
  await expect(readMedia({ path, frame: 0.5 }, signal(), true)).rejects.toMatchObject({
    code: "VALIDATION",
  });
});

test("bounds previews to 1600px without enlarging small images", async () => {
  const path = await save(await generated(2400, 1200).png().toBuffer());
  expect((await readMedia({ path }, signal(), true))?.details).toMatchObject({
    width: 2400,
    height: 1200,
    previewWidth: 1600,
    previewHeight: 800,
  });
});

test.each(["gif", "webp"] as const)(
  "batch %s frames retain timing metadata and bound the selected frames",
  async (format) => {
    const raw = Buffer.alloc(6 * 12 * 4, 255);
    for (let i = 0; i < 6 * 6; i++) {
      raw[i * 4 + 1] = 0;
      raw[i * 4 + 2] = 0;
    }
    for (let i = 6 * 6; i < 6 * 12; i++) {
      raw[i * 4] = 0;
      raw[i * 4 + 2] = 0;
    }
    const bytes = await sharp(raw, { raw: { width: 6, height: 12, channels: 4, pageHeight: 6 } })
      .toFormat(format, { delay: [80, 160], loop: 3 })
      .toBuffer();
    const path = await save(bytes);
    const output = await readMedia({ path, frames: [1, 0], thumbnail: true }, signal(), true);
    expect(output?.details).toMatchObject({
      frames: 2,
      selectedFrames: [1, 0],
      animation: {
        animated: true,
        frameDelayMs: [80, 160],
        durationMs: 240,
        loop: 3,
        playbackVerified: false,
      },
    });
    expect(output?.content.filter((p) => p.type === "image")).toHaveLength(2);
    expect(output?.content[1]).not.toEqual(output?.content[2]);
    await expect(
      readMedia({ path, frames: [0, 1, 2, 3, 4] }, signal(), true),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  },
);

test("applies JPEG orientation to the returned preview", async () => {
  const path = await save(await generated().jpeg().withMetadata({ orientation: 6 }).toBuffer());
  expect((await readMedia({ path }, signal(), true))?.details).toMatchObject({
    format: "jpeg",
    width: 16,
    height: 12,
    previewWidth: 12,
    previewHeight: 16,
  });
});

test("rejects recognized but damaged images rather than returning binary as text", async () => {
  const path = await save(png.subarray(0, 16));
  await expect(readMedia({ path }, signal(), true)).rejects.toMatchObject({
    code: "VALIDATION",
    message: expect.stringContaining("无法解码"),
  });
});

test("explicit image mode rejects ordinary text and renders supported SVG bytes", async () => {
  const text = await save("plain text");
  await expect(readMedia({ path: text, mode: "image" }, signal(), true)).rejects.toMatchObject({
    code: "VALIDATION",
  });
  const svg = await save('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  const output = await readMedia({ path: svg, mode: "image" }, signal(), true);
  expect(output?.details).toMatchObject({ format: "svg", width: 1, height: 1 });
  expect(output?.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
});

test("rejects files beyond 20MiB before attempting to decode them", async () => {
  const path = await save(png);
  const handle = await open(path, "r+");
  try {
    await handle.truncate(20 * 1024 * 1024 + 1);
  } finally {
    await handle.close();
  }
  await expect(readMedia({ path }, signal(), true)).rejects.toMatchObject({
    code: "VALIDATION",
    message: expect.stringContaining("20MB"),
  });
});

test("rejects excessive pixel dimensions without allocating a full raster", async () => {
  // A valid IHDR checksum lets libvips reject the declared pixel count before
  // it could attempt to inflate a raster; no large test fixture is required.
  const bytes = Buffer.from(png);
  bytes.writeUInt32BE(6400, 16);
  bytes.writeUInt32BE(6400, 20);
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
  await expect(sharp(bytes, { limitInputPixels: 40_000_000 }).metadata()).rejects.toThrow(
    "Input image exceeds pixel limit",
  );
  const path = await save(bytes);
  await expect(readMedia({ path }, signal(), true)).rejects.toMatchObject({
    code: "VALIDATION",
    message: expect.stringContaining("预览限制"),
  });
});

test("rejects a preview larger than 8MiB even when the input file is within 20MiB", async () => {
  const bytes = await sharp(randomBytes(1600 * 1600 * 4), {
    raw: { width: 1600, height: 1600, channels: 4 },
  })
    .png()
    .toBuffer();
  expect(bytes.length).toBeGreaterThan(8 * 1024 * 1024);
  expect(bytes.length).toBeLessThan(20 * 1024 * 1024);
  const path = await save(bytes);
  await expect(readMedia({ path }, signal(), true)).rejects.toMatchObject({
    code: "VALIDATION",
    message: expect.stringContaining("预览过大"),
  });
});

test("preserves the cancellation reason before and during an image read", async () => {
  const reason = new Error("fixture image read cancelled");
  const stopped = new AbortController();
  stopped.abort(reason);
  await expect(readMedia({ path: join(directory, "absent") }, stopped.signal, true)).rejects.toBe(
    reason,
  );
  const path = await save(png);
  const active = new AbortController();
  const pending = readMedia({ path }, active.signal, true);
  active.abort(reason);
  await expect(pending).rejects.toBe(reason);
});

test("rejects a directory and does not follow a final-component symlink", async () => {
  await expect(readMedia({ path: directory }, signal(), true)).rejects.toMatchObject({
    code: "VALIDATION",
    message: expect.stringContaining("普通文件"),
  });
  const target = await save(png);
  const linked = join(directory, "linked.png");
  await symlink(target, linked);
  await expect(readMedia({ path: linked }, signal(), true)).rejects.toMatchObject({
    code: "ELOOP",
  });
});
