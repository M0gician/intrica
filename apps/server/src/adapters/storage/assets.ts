import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { MAX_IMAGE_PIXELS } from "@intrica/contracts";
import sharp from "sharp";
import { readFilePreview, sniffMime } from "../host/file-preview.js";
import { readPdf } from "../host/pdf-reader.js";
import { type Database, DomainError, id } from "../postgres/database.js";

export class AssetStore {
  constructor(
    readonly db: Database,
    readonly directory: string,
  ) {}
  /** Copy authorized file bytes before publishing. A node's asset FK retains the snapshot. */
  async snapshot(path: string) {
    const stage = join(this.directory, "assets", ".staging");
    await mkdir(stage, { recursive: true, mode: 0o700 });
    const temporary = join(stage, id("file"));
    const input = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await input.stat();
      if (!before.isFile() || before.size > 256 * 1024 * 1024)
        throw new DomainError("FILE_LIMIT", "发布附件必须是 256 MiB 以内的普通文件");
      const output = await open(temporary, "wx", 0o600);
      const hash = createHash("sha256");
      let size = 0,
        header = Buffer.alloc(0);
      try {
        for await (const chunk of input.createReadStream({ autoClose: false })) {
          size += chunk.length;
          if (size > before.size) throw new DomainError("TARGET_CHANGED", "文件在发布期间发生变化");
          if (header.length < 8192)
            header = Buffer.concat([header, chunk.subarray(0, 8192 - header.length)]);
          hash.update(chunk);
          await output.writeFile(chunk);
        }
        const after = await input.stat();
        if (
          size !== before.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new DomainError("TARGET_CHANGED", "文件在发布期间发生变化");
        await output.sync();
      } finally {
        await output.close();
      }
      const contentHash = hash.digest("hex"),
        assetId = `asset-${contentHash}`;
      const destination = join(this.directory, "assets", contentHash);
      await mkdir(destination, { recursive: true });
      await rename(temporary, join(destination, "original"));
      const mime = sniffMime(header, path, size > header.length);
      let width = 1,
        height = 1;
      if (mime.startsWith("image/")) {
        try {
          const image = sharp(join(destination, "original"), {
            limitInputPixels: MAX_IMAGE_PIXELS,
          });
          const metadata = await image.metadata();
          width = metadata.width ?? 1;
          height = metadata.height ?? 1;
          await image
            .resize(512, 512, { fit: "inside", withoutEnlargement: true })
            .png()
            .toFile(join(destination, "thumb.png"));
        } catch {
          /* A corrupt file still has a downloadable original. */
        }
      }
      await this.db.pool.query(
        "insert into assets(id,content_hash,storage_key,mime,bytes,width,height,state) values($1,$2,$3,$4,$5,$6,$7,'ready') on conflict(content_hash) do nothing",
        [assetId, contentHash, contentHash, mime, size, width, height],
      );
      return { assetId, hash: contentHash, bytes: size, mime, name: basename(path) };
    } finally {
      await input.close();
      await rm(temporary, { force: true });
    }
  }
  async preview(assetId: string, name: string) {
    const row = await this.get(assetId);
    return {
      ...(await readFilePreview(join(this.directory, "assets", row.storage_key, "original"), name)),
      path: "",
    };
  }
  async assertAvailable(assetId: string) {
    const row = await this.get(assetId);
    const file = await open(
      join(this.directory, "assets", row.storage_key, "original"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== Number(row.bytes))
        throw new DomainError("TARGET_CHANGED", "交付文件缺失或已变化");
    } finally {
      await file.close();
    }
  }
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
    const data = buffer;
    let mime: string;
    if (format === "svg") {
      mime = "image/svg+xml";
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
      const original = await readFile(join(this.directory, "assets", row.storage_key, "original"));
      if (row.mime === "image/svg+xml")
        return {
          data: await sharp(original, { limitInputPixels: MAX_IMAGE_PIXELS }).png().toBuffer(),
          mime: "image/png",
        };
      return {
        data: original,
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
      size: thumb ? undefined : Number(row.bytes),
      hash: row.content_hash,
    };
  }
}
