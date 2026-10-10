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
      const contentHash = hash.digest("hex");
      const mime = sniffMime(header, path, size > header.length);
      let width = 1,
        height = 1,
        thumb: Buffer | undefined;
      if (mime.startsWith("image/")) {
        try {
          const image = sharp(temporary, { limitInputPixels: MAX_IMAGE_PIXELS });
          const metadata = await image.metadata();
          width = metadata.width ?? 1;
          height = metadata.height ?? 1;
          thumb = await image
            .resize(512, 512, { fit: "inside", withoutEnlargement: true })
            .png()
            .toBuffer();
        } catch {
          /* Corrupt files retain their original-byte download. */
        }
      }
      const assetId = await this.persistBlob(
        contentHash,
        mime,
        size,
        width,
        height,
        temporary,
        thumb,
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
  private async persistBlob(
    hash: string,
    mime: string,
    bytes: number,
    width: number,
    height: number,
    source: Buffer | string,
    thumb?: Buffer,
  ) {
    const assetId = `asset-${hash}`;
    await this.db.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`asset:${hash}`]);
      const directory = join(this.directory, "assets", hash);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = typeof source === "string" ? source : join(directory, id("upload"));
      if (typeof source !== "string")
        await writeFile(temporary, source, { flag: "wx", mode: 0o600 });
      await rename(temporary, join(directory, "original"));
      if (thumb) {
        const staged = join(directory, id("thumb"));
        await writeFile(staged, thumb, { flag: "wx", mode: 0o600 });
        await rename(staged, join(directory, "thumb.png"));
      }
      await tx.query(
        "insert into assets(id,content_hash,storage_key,mime,bytes,width,height,state) values($1,$2,$2,$3,$4,$5,$6,'ready') on conflict(content_hash) do update set last_used_at=now(),state='ready'",
        [assetId, hash, mime, bytes, width, height],
      );
    });
    return assetId;
  }
  async put(buffer: Buffer) {
    const hash = createHash("sha256").update(buffer).digest("hex");
    if (buffer.subarray(0, 5).toString() === "%PDF-") {
      let page: Awaited<ReturnType<typeof readPdf>>;
      try {
        page = await readPdf(buffer, { page: 1, render: true });
      } catch (error) {
        throw new DomainError("ASSET_INVALID", (error as Error).message);
      }
      const thumb = await sharp(Buffer.from(page.image!, "base64"))
        .resize(512, 512, { fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
      const assetId = await this.persistBlob(
        hash,
        "application/pdf",
        buffer.length,
        Math.ceil(page.width),
        Math.ceil(page.height),
        buffer,
        thumb,
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
    const types: Record<string, string> = {
      svg: "image/svg+xml",
      png: "image/png",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
    };
    const mime = types[metadata.format ?? ""];
    if (!mime) throw new DomainError("ASSET_INVALID", "不支持此图片类型");
    const thumb = await sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS })
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    const assetId = await this.persistBlob(
      hash,
      mime,
      buffer.length,
      metadata.width ?? 1,
      metadata.height ?? 1,
      buffer,
      thumb,
    );
    return {
      assetId,
      assetVersion: 1,
      width: metadata.width ?? 1,
      height: metadata.height ?? 1,
      mime,
    };
  }
  /** Tool evidence is retained even if a provider returned an undecodable image. */
  async putMedia(buffer: Buffer) {
    const hash = createHash("sha256").update(buffer).digest("hex"),
      mime = sniffMime(buffer, "media");
    let width = 1,
      height = 1,
      thumb: Buffer | undefined;
    try {
      const image = sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS }),
        metadata = await image.metadata();
      width = metadata.width ?? 1;
      height = metadata.height ?? 1;
      thumb = await image
        .resize(512, 512, { fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
    } catch {
      /* Original evidence remains available for diagnosis. */
    }
    return {
      assetId: await this.persistBlob(hash, mime, buffer.length, width, height, buffer, thumb),
      mime,
    };
  }
  /** Thirty-day orphan grace. Row locks and blob locks serialize collection with reuse. */
  async prune() {
    const candidates = (
      await this.db.pool.query(
        "select id,content_hash from assets where last_used_at<now()-interval '30 days' order by last_used_at limit 50",
      )
    ).rows;
    for (const candidate of candidates)
      await this.db.transaction(async (tx) => {
        await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          `asset:${candidate.content_hash}`,
        ]);
        const asset = (
          await tx.query(
            "select * from assets where id=$1 and last_used_at<now()-interval '30 days' for update",
            [candidate.id],
          )
        ).rows[0];
        if (!asset || !/^[a-f0-9]{64}$/.test(asset.storage_key)) return;
        const referenced = (
          await tx.query(
            `select
        exists(select 1 from nodes where asset_id=$1) or exists(select 1 from media_references where asset_id=$1)
        or exists(select 1 from commands where undo_patch::text like '%'||$1||'%')
        or exists(select 1 from runs where frozen_input::text like '%'||$1||'%')
        or exists(select 1 from proposals where items::text like '%'||$1||'%')
        or exists(select 1 from conversations where checkpoint::text like '%'||$1||'%')
        or exists(select 1 from messages where content::text like '%'||$1||'%') as present`,
            [asset.id],
          )
        ).rows[0].present;
        if (referenced) return;
        // The row lock prevents a new FK reference from racing file deletion.
        await rm(join(this.directory, "assets", asset.storage_key), {
          recursive: true,
          force: true,
        }).catch(() => {});
        await tx.query("delete from assets where id=$1", [asset.id]);
      });
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
  async originalBytes(assetId: string, maxBytes: number) {
    const row = await this.get(assetId);
    if (Number(row.bytes) > maxBytes)
      throw new DomainError("FILE_LIMIT", "附件超过此次读取的大小限制");
    const handle = await open(
      join(this.directory, "assets", row.storage_key, "original"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== Number(row.bytes))
        throw new DomainError("TARGET_CHANGED", "附件大小已变化");
      const data = Buffer.alloc(info.size + 1);
      let size = 0;
      while (size < data.length) {
        const r = await handle.read(data, size, data.length - size, size);
        if (!r.bytesRead) break;
        size += r.bytesRead;
      }
      const bytes = data.subarray(0, size);
      if (
        size !== info.size ||
        createHash("sha256").update(bytes).digest("hex") !== row.content_hash
      )
        throw new DomainError("TARGET_CHANGED", "附件内容已变化");
      return bytes;
    } finally {
      await handle.close();
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
