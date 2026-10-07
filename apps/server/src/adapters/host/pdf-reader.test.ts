import { deflateSync } from "node:zlib";
import sharp from "sharp";
import { expect, it } from "vitest";
import { PDF_FIXTURE } from "../../../../../tests/fixtures/pdf.mjs";
import { readPdf } from "./pdf-reader.js";

// A real PDF image XObject, not metadata-only dimensions. Grayscale keeps the
// fixture inexpensive while still exercising the parser's decoded-pixel limit.
function scannedPage(width: number, height: number) {
  const raster = deflateSync(Buffer.alloc(width * height, 48));
  const drawing = Buffer.from("q 595 0 0 842 0 0 cm /Scan Do Q");
  const stream = (dict: string, bytes: Buffer) =>
    Buffer.concat([
      Buffer.from(`<< ${dict} /Length ${bytes.length} >>\nstream\n`),
      bytes,
      Buffer.from("\nendstream"),
    ]);
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Scan 4 0 R >> >> /Contents 5 0 R >>",
    ),
    stream(
      `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`,
      raster,
    ),
    stream("", drawing),
  ];
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(parts.reduce((total, part) => total + part.length, 0));
    parts.push(Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n"));
  }
  const xref = parts.reduce((total, part) => total + part.length, 0);
  parts.push(
    Buffer.from(
      `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}

it("extracts actual text and renders distinct pages without claiming OCR", async () => {
  const first = await readPdf(PDF_FIXTURE, { page: 1, render: true });
  expect(first).toMatchObject({ page: 1, pageCount: 2, nextPage: 2, hasText: true });
  expect(first.text).toContain("INTRICA-PDF-042");
  expect(Buffer.from(first.image!, "base64").subarray(1, 4).toString()).toBe("PNG");
  const second = await readPdf(PDF_FIXTURE, { page: 2, render: true });
  expect(second).toMatchObject({ nextPage: null, hasText: false, text: "" });
  expect(second.image).not.toBe(first.image);
  expect(second.note).toContain("no OCR");
  const a = await readPdf(PDF_FIXTURE, { page: 1, characterOffset: 0, characterLimit: 10 });
  const b = await readPdf(PDF_FIXTURE, { page: 1, characterOffset: 10, characterLimit: 10 });
  expect(a.nextCharOffset).toBe(10);
  expect(a.text + b.text).toBe(first.text.slice(0, 20));
});
it("rejects invalid/page out of range/oversized PDFs and honors cancellation", async () => {
  await expect(readPdf(Buffer.from("%PDF-invalid"), {})).rejects.toMatchObject({
    code: "VALIDATION",
  });
  await expect(readPdf(PDF_FIXTURE, { page: 3 })).rejects.toMatchObject({ code: "VALIDATION" });
  await expect(readPdf(Buffer.alloc(21 * 1024 * 1024), {})).rejects.toMatchObject({
    code: "VALIDATION",
  });
  const c = new AbortController();
  c.abort(new Error("cancel PDF"));
  await expect(readPdf(PDF_FIXTURE, {}, c.signal)).rejects.toThrow("cancel PDF");
});

it("renders an actual 300 DPI A4 scan above 4MP while retaining the 16MP embedded-image limit", async () => {
  const page = await readPdf(scannedPage(2480, 3508), { render: true });
  expect(page).toMatchObject({ pageCount: 1, hasText: false, text: "" });
  const preview = sharp(Buffer.from(page.image!, "base64"));
  const metadata = await preview.metadata();
  expect(metadata.height).toBeLessThanOrEqual(1600);
  // Prove the image was actually painted, not silently discarded into white.
  const stats = await preview.stats();
  expect(stats.channels[0]!.mean).toBeLessThan(100);
  const oversized = scannedPage(4001, 4000);
  await expect(
    readPdf(oversized, { render: true }).then(({ image: _image, ...metadata }) => metadata),
  ).rejects.toMatchObject({
    code: "VALIDATION",
    message: expect.stringContaining("Image exceeded maximum allowed size"),
  });
  // Text-only reads do not decode embedded images and remain usable even when
  // this page cannot be rendered within the raster budget.
  const textOnly = await readPdf(oversized, { render: false });
  expect(textOnly).toMatchObject({ hasText: false, text: "" });
  expect(textOnly.image).toBeUndefined();
});
