import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_IMAGE_PIXELS } from "@intrica/contracts";
import sharp from "sharp";
import { readPdf } from "../host/pdf-reader.js";
import { type Database, DomainError, id } from "../postgres/database.js";

export class AssetStore {
  constructor(
    readonly db: Database,
    readonly directory: string,
  ) {}
  async put(buffer: Buffer) {
    if (buffer.subarray(0, 5).toString() === "%PDF-") {
      let page: Awaited<ReturnType<typeof readPdf>>;
      try {
        page = await readPdf(buffer, { page: 1, render: true });
      } catch (error) {
        throw new DomainError("ASSET_INVALID", (error as Error).message);
      }
      const hash = createHash("sha256").update(buffer).digest("hex"),
        assetId = `asset-${hash}`;
      const dir = join(this.directory, "assets", hash);
      await mkdir(dir, { recursive: true });
      const temp = join(dir, id("upload"));
      await writeFile(temp, buffer, { flag: "wx" });
      await rename(temp, join(dir, "original"));
      const thumb = await sharp(Buffer.from(page.image!, "base64"))
        .resize(512, 512, { fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
      const temporary = join(dir, id("thumb"));
      await writeFile(temporary, thumb, { flag: "wx" });
      await rename(temporary, join(dir, "thumb.png"));
      await this.db.pool.query(
        "insert into assets(id,content_hash,storage_key,mime,bytes,width,height,state) values($1,$2,$3,'application/pdf',$4,$5,$6,'ready') on conflict(content_hash) do nothing",
        [assetId, hash, hash, buffer.length, Math.ceil(page.width), Math.ceil(page.height)],
      );
      return {
        assetId,
        assetVersion: 1,
        mime: "application/pdf",
        width: page.width,
        height: page.height,
        pageCount: page.pageCount,
      };
    }
    let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
    try {
      metadata = await sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
    } catch {
      throw new DomainError("ASSET_INVALID", "图片无效或超过像素限制");
    }
    const format = metadata.format;
    let data = buffer;
    let mime: string;
    if (format === "svg") {
      data = await sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS }).png().toBuffer();
      metadata = await sharp(data).metadata();
      mime = "image/png";
    } else {
      const types: Record<string, string> = {
        png: "image/png",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
      };
      mime = types[format ?? ""] ?? "";
      if (!mime) throw new DomainError("ASSET_INVALID", "不支持此图片类型");
    }
    const hash = createHash("sha256").update(data).digest("hex");
    const assetId = `asset-${hash}`;
    const dir = join(this.directory, "assets", hash);
    await mkdir(dir, { recursive: true });
    const temp = join(dir, id("upload"));
    await writeFile(temp, data, { flag: "wx" });
    await rename(temp, join(dir, "original"));
    const thumb = await sharp(data)
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    const thumbTemp = join(dir, id("thumb"));
    await writeFile(thumbTemp, thumb, { flag: "wx" });
    await rename(thumbTemp, join(dir, "thumb.png"));
    await this.db.pool.query(
      "insert into assets(id,content_hash,storage_key,mime,bytes,width,height,state) values($1,$2,$3,$4,$5,$6,$7,'ready') on conflict(content_hash) do nothing",
      [assetId, hash, hash, mime, data.length, metadata.width ?? 1, metadata.height ?? 1],
    );
    return {
      assetId,
      assetVersion: 1,
      width: metadata.width ?? 1,
      height: metadata.height ?? 1,
      mime,
    };
  }
  async get(assetId: string) {
    const row = (
      await this.db.pool.query("select * from assets where id=$1 and state='ready'", [assetId])
    ).rows[0];
    if (!row) throw new DomainError("NOT_FOUND", "图片不存在");
    return row;
  }
  async resolve(assetId: string) {
    try {
      const row = await this.get(assetId);
      return {
        data: await readFile(join(this.directory, "assets", row.storage_key, "original")),
        mime: row.mime as string,
      };
    } catch {
      return null;
    }
  }
  async stream(assetId: string, thumb = false) {
    const row = await this.get(assetId);
    return {
      stream: createReadStream(
        join(this.directory, "assets", row.storage_key, thumb ? "thumb.png" : "original"),
      ),
      mime: thumb ? "image/png" : row.mime,
    };
  }
}
