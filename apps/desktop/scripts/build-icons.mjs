import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "assets/icon.svg");
const uiMark = resolve(root, "../web/public/brand-mark.svg");
await mkdir(dirname(uiMark), { recursive: true });
await copyFile(source, uiMark);
await sharp(source).resize(1024, 1024).png().toFile(resolve(root, "assets/icon.png"));

// Modern ICNS stores a PNG per size, so icon generation also works off macOS.
const chunks = [];
for (const [type, size] of [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
]) {
  const png = await sharp(source).resize(size, size).png().toBuffer();
  const header = Buffer.alloc(8);
  header.write(type);
  header.writeUInt32BE(png.length + 8, 4);
  chunks.push(header, png);
}
const header = Buffer.alloc(8);
header.write("icns");
header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
await writeFile(resolve(root, "assets/icon.icns"), Buffer.concat([header, ...chunks]));
console.log("Updated SVG, PNG and ICNS from assets/icon.svg");
