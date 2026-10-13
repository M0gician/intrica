import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { readPdf } from "../adapters/host/pdf-reader.js";
import { HostClient } from "../adapters/host/rpc.js";
import { DomainError } from "../adapters/postgres/database.js";
import type { AppInstance } from "../app.js";
import type { Kernel } from "../composition.js";
import { FileReferences } from "../modules/work/file-references.js";
import { createStream } from "./streams.js";

const path = Type.String({ maxLength: 4096 });
export function registerWorkspace(app: AppInstance, k: Kernel, serverId: string) {
  app.get(
    "/api/v2/media/:id",
    { schema: { params: Type.Object({ id: Type.String({ maxLength: 200 }) }) } },
    async (req, reply) => {
      const media = await k.runs.media!.ownerStream(req.params.id);
      return reply
        .type(media.mime)
        .header("Content-Security-Policy", "sandbox; default-src 'none'")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "private, no-store")
        .send(media.stream);
    },
  );
  const host = new HostClient(k.config.dataDir);
  const files = new FileReferences(k, serverId);
  const reference = Type.String({ minLength: 1, maxLength: 24000 });
  const pdfQuery = Type.Object({
    page: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
    render: Type.Optional(Type.Boolean()),
    characterOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000000 })),
    characterLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 48000 })),
  });
  app.get("/api/v2/files/preview", { schema: { querystring: Type.Object({ reference }) } }, (req) =>
    files.preview(req.query.reference),
  );
  app.get(
    "/api/v2/files/pdf",
    { schema: { querystring: Type.Object({ reference, ...pdfQuery.properties }) } },
    async (req) => {
      const source = await files.resolve(req.query.reference);
      if (!source.assetId) return host.call("pdf", { ...req.query, path: source.path });
      const asset = await k.assets.resolve(source.assetId);
      if (asset?.mime !== "application/pdf") throw new DomainError("VALIDATION", "此文件不是 PDF");
      return readPdf(asset.data, {
        ...req.query,
        page: req.query.page ?? 1,
        render: req.query.render ?? true,
      });
    },
  );
  app.get(
    "/api/v2/files/download",
    { schema: { querystring: Type.Object({ reference }) } },
    async (req, reply) => {
      const abort = new AbortController();
      reply.raw.once("close", () => abort.abort());
      const file = await files.download(req.query.reference, abort.signal);
      if ("hash" in file) reply.header("ETag", `"sha256-${file.hash}"`);
      return reply
        .header(
          "Content-Disposition",
          `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
        )
        .header("Content-Length", file.size)
        .header("X-Content-Type-Options", "nosniff")
        .type("application/octet-stream")
        .send(file.stream);
    },
  );
  app.get(
    "/api/v2/nodes/:id/pdf",
    { schema: { params: Type.Object({ id: Type.String() }), querystring: pdfQuery } },
    async (req) => {
      const node = await k.graph.queries.node(req.params.id);
      if (node.kind !== "pdf") throw new DomainError("VALIDATION", "此节点不是 PDF");
      if (node.resource?.type === "file" && !node.resource.snapshot)
        return host.call("pdf", { path: node.resource.path, ...req.query });
      const asset = node.assetId ? await k.assets.resolve(node.assetId) : null;
      if (asset?.mime !== "application/pdf") throw new DomainError("NOT_FOUND", "PDF 附件不存在");
      return readPdf(asset.data, {
        ...req.query,
        page: req.query.page ?? 1,
        render: req.query.render ?? true,
      });
    },
  );
  app.get(
    "/api/v2/workspace/pdf",
    {
      schema: {
        querystring: Type.Object({ path, ...pdfQuery.properties }),
      },
    },
    async (req) => host.call("pdf", req.query),
  );
  app.get(
    "/api/v2/workspace/download",
    { schema: { querystring: Type.Object({ path }) } },
    async (req, reply) => {
      const abort = new AbortController();
      const cancel = () => abort.abort();
      reply.raw.once("close", cancel);
      try {
        const file = await host.download(req.query.path, abort.signal);
        return reply
          .header(
            "Content-Disposition",
            `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
          )
          .header("Content-Length", file.size)
          .header("X-Content-Type-Options", "nosniff")
          .type("application/octet-stream")
          .send(file.stream);
      } catch (error) {
        reply.raw.removeListener("close", cancel);
        throw error;
      }
    },
  );
  app.get(
    "/api/v2/workspace/root",
    { schema: { querystring: Type.Object({ canvasId: Type.Optional(Type.String()) }) } },
    async (req) => {
      if (req.query.canvasId) await k.graph.queries.canvasId(req.query.canvasId);
      return host.call("workspace.root", req.query);
    },
  );
  app.get(
    "/api/v2/workspace/files",
    {
      schema: {
        querystring: Type.Object({
          path: Type.Optional(path),
          search: Type.Optional(Type.String({ maxLength: 200 })),
        }),
      },
    },
    async (req) => host.call("files", req.query),
  );
  app.get(
    "/api/v2/workspace/file",
    { schema: { querystring: Type.Object({ path }) } },
    async (req) => ({ ...(await host.call("file", req.query)), serverId }),
  );
  app.get(
    "/api/v2/workspace/image",
    { schema: { querystring: Type.Object({ path }) } },
    async (req, reply) => {
      const file = await host.call("file", req.query);
      if (!file.data) throw new DomainError("VALIDATION", "此文件不是图片");
      return reply
        .header("Content-Security-Policy", "sandbox")
        .type(file.mime)
        .send(Buffer.from(file.data, "base64"));
    },
  );
  app.get(
    "/api/v2/workspace/web-title",
    { schema: { querystring: Type.Object({ url: Type.String({ maxLength: 4096 }) }) } },
    async (req) => host.call("web-title", req.query),
  );
  app.post(
    "/api/v2/workspace/terminals",
    {
      schema: {
        body: Type.Object({
          cwd: Type.Optional(path),
          cols: Type.Integer({ minimum: 10, maximum: 500 }),
          rows: Type.Integer({ minimum: 3, maximum: 200 }),
        }),
      },
    },
    async (req) => host.call("terminal.create", req.body),
  );
  app.post(
    "/api/v2/workspace/terminals/:id/input",
    {
      schema: {
        params: Type.Object({ id: Type.String() }),
        body: Type.Object({
          data: Type.Optional(Type.String({ maxLength: 16000 })),
          cols: Type.Optional(Type.Integer({ minimum: 10, maximum: 500 })),
          rows: Type.Optional(Type.Integer({ minimum: 3, maximum: 200 })),
        }),
      },
    },
    async (req) => host.call("terminal.input", { ...req.body, id: req.params.id }),
  );
  app.delete(
    "/api/v2/workspace/terminals/:id",
    { schema: { params: Type.Object({ id: Type.String() }) } },
    async (req) => host.call("terminal.close", req.params),
  );
  app.get(
    "/api/v2/workspace/terminals/:id/output",
    { schema: { params: Type.Object({ id: Type.String() }) } },
    async (req, reply) =>
      createStream(app, reply, async function* (signal) {
        let after = 0;
        while (!signal.aborted) {
          const output = await host.call("terminal.poll", { id: req.params.id, after });
          for (const chunk of output.chunks) {
            after = chunk.seq;
            yield { type: "output", data: chunk.data };
          }
          if (output.exitCode !== null) {
            yield { type: "exit", exitCode: output.exitCode };
            return;
          }
          await delay(100, undefined, { signal });
        }
      }),
  );
  app.post("/api/v2/assets", async (req) => {
    let buffer: Buffer | undefined;
    for await (const part of req.parts()) if (part.type === "file") buffer = await part.toBuffer();
    if (!buffer) throw new DomainError("ASSET_INVALID", "请选择图片或 PDF");
    return k.assets.put(buffer);
  });
  app.get(
    "/api/v2/assets/:id",
    {
      schema: {
        params: Type.Object({ id: Type.String() }),
        querystring: Type.Object({
          variant: Type.Optional(Type.String()),
          version: Type.Optional(Type.Integer()),
        }),
      },
    },
    async (req, reply) => {
      const asset = await k.assets.stream(req.params.id, req.query.variant === "thumb");
      if (asset.size !== undefined)
        reply.header("Content-Length", asset.size).header("ETag", `"sha256-${asset.hash}"`);
      return reply
        .type(asset.mime)
        .header("Content-Security-Policy", "sandbox; default-src 'none'; img-src data:")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .send(asset.stream);
    },
  );
}
