import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { OwnerHost } from "../../apps/server/dist/adapters/host/owner.js";
import { startHostServer } from "../../apps/server/dist/adapters/host/rpc.js";
import { Database } from "../../apps/server/dist/adapters/postgres/database.js";
import { grantsFor } from "../../apps/server/dist/modules/access/policy.js";
import { invokeTool } from "../../apps/server/dist/modules/execution/tool-calls.js";

const { PDF_FIXTURE }: { PDF_FIXTURE: Buffer } = await import(
  new URL("../fixtures/pdf.mjs", import.meta.url).href
);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQMgkTMgljgFAAEA4CcV2GZ44AAAAASUVORK5CYII=",
  "base64",
);
const key = () => randomUUID();
const adminUrl = process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres";
const databaseName = `intrica_pdf_${key().replaceAll("-", "")}`;
const token = key();
const headers = { authorization: `Bearer ${token}` };
const position = { x: 0, y: 0, width: 220, height: 300 };
let app: Awaited<ReturnType<typeof buildServer>>, k: Kernel, dataDir: string, files: string;
let pdfAsset: Awaited<ReturnType<Kernel["assets"]["put"]>>;
let hostServer: Awaited<ReturnType<typeof startHostServer>> | undefined;
let priorVersion: number;

async function admin(sql: string) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  await admin(`create database ${databaseName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  dataDir = await realpath(await mkdtemp(join(tmpdir(), "intrica-pdf-data-")));
  files = await realpath(await mkdtemp(join(tmpdir(), "intrica-pdf-files-")));

  // Use the archived pre-upgrade schema plus its actual migrations; do not
  // synthesize schema 7 by editing current schema 8 or downgrading a live server.
  const old = new Database(url.href);
  try {
    await old.pool.query("create schema intrica");
    for (const path of [
      "../fixtures/schema-v5.sql",
      "../../db/migrations/0006-approvals.sql",
      "../../db/migrations/0007-delegated-resources.sql",
    ])
      await old.pool.query(await readFile(new URL(path, import.meta.url), "utf8"));
    await old.pool.query(
      "insert into canvases(id,title) values('pdf-upgrade-board','kept canvas')",
    );
    await old.pool.query(`insert into nodes(id,canvas_id,sort_key,kind,body,x,y,w,h)
      values('pdf-upgrade-text','pdf-upgrade-board',1,'text','{"title":"old text","text":"existing evidence"}',0,0,200,100)`);
    priorVersion = (await old.pool.query("select version from schema_info")).rows[0].version;
  } finally {
    await old.close();
  }
  app = await buildServer({
    databaseUrl: url.href,
    dataDir,
    accessToken: token,
    worker: false,
    model: { kind: "mock", supportsVision: true, streamDelayMs: 0 },
  });
  await app.ready();
  k = app.kernel;
  // worker:false gives deterministic durable-tool scheduling; start the real
  // owner RPC separately to cover file-backed HTTP previews as well as assets.
  hostServer = await startHostServer(dataDir, new OwnerHost(dataDir));
  pdfAsset = await k.assets.put(PDF_FIXTURE);
});

afterEach(async () => {
  if (!k) return;
  await k.db.pool.query("update conversations set consumed_message_seq=message_seq");
  await k.db.pool.query("update schedules set enabled=false");
  await k.db.pool.query("update approvals set status='cancelled' where status='pending'");
  await k.db.pool.query(
    "update runs set state='cancelled',cancel_requested_at=now() where state in('queued','running','waiting')",
  );
});
afterAll(async () => {
  await hostServer?.close();
  await app?.close();
  await admin(`drop database if exists ${databaseName} with(force)`);
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  if (files) await rm(files, { recursive: true, force: true });
});

const canvas = async () =>
  (await k.graph.createCanvas({ title: "PDF evidence", idempotencyKey: key() })).node.id;
const agent = async (parentId: string, role: "read" | "write" = "read") =>
  (
    await k.graph.createNode({
      kind: "agent",
      parentId,
      title: "PDF reader",
      position,
      agent: { persona: "Read evidence with its page number", role, enabled: true },
      idempotencyKey: key(),
    })
  ).node;
const pdfNode = async (parentId: string) =>
  (
    await k.graph.createNode({
      kind: "pdf",
      parentId,
      title: "Two-page source.pdf",
      assetId: pdfAsset.assetId,
      position,
      idempotencyKey: key(),
    })
  ).node;
const connect = (agentId: string, resourceId: string) =>
  k.graph.createLink({ fromId: agentId, toId: resourceId, idempotencyKey: key() });

async function session(agentId: string, supportsVision = true) {
  const node = await k.graph.queries.node(agentId);
  const submitted = await k.conversations.submit({
    canvasId: node.canvasId!,
    agentId,
    message: "Read PDF evidence",
    key: key(),
  });
  const run = (await k.runs.claim("pdf-integration"))!;
  expect(run.id).toBe(submitted.run.id);
  const ctx = { run, store: k.runs, signal: new AbortController().signal, progress() {} };
  const input = {
    ...run.frozen_input,
    model: { config: { kind: "mock" as const, streamDelayMs: 0, supportsVision } },
  };
  const tools = await k.tools.create(ctx, input);
  return {
    run,
    ctx,
    input,
    tools,
    actor: { kind: "agent" as const, agentId, runId: run.id, epoch: run.epoch },
    async call(name: string, args: object, logical = key(), definitions = tools) {
      const tool = definitions.find((item) => item.name === name);
      expect(tool, `durable tool ${name}`).toBeDefined();
      const execution = await invokeTool(ctx, tool!, logical, args);
      const content = execution.result.content.find((part) => part.type === "text");
      const text = content?.type === "text" ? content.text : "";
      let value: any = text;
      try {
        value = JSON.parse(text);
      } catch {}
      return { ...execution, value, logical };
    },
  };
}
async function approve(id: string) {
  const request = (await k.db.pool.query("select * from approvals where id=$1", [id])).rows[0];
  await k.access.decide(id, request.version, "approve", "fixture owner approval");
  return request;
}
const hasImage = (result: { content: Array<{ type: string }> }) =>
  result.content.some((part) => part.type === "image");

describe("PDF canvas, multimodal read and durable authorization", () => {
  it("published files retain bytes after overwrite/deletion and scoped references recheck grants", async () => {
    const c = await canvas(),
      writer = await agent(c, "write"),
      reader = await agent(c, "write");
    const child = await session(writer.id);
    const path = join((await k.host.scope(child.actor)).scratch, "Unicode 报告.bin");
    const original = Buffer.from("Published version αβγ");
    await writeFile(path, original);
    const created = await child.call("create_artifact", { kind: "text", title: "Delivery", path });
    expect(created.result.isError).not.toBe(true);
    const nodeId = created.value.id;
    const node = await k.graph.queries.node(nodeId);
    expect(node.resource?.snapshot).toMatchObject({ bytes: original.length, mime: "text/plain" });
    const serverId = (await app.inject({ url: "/api/v2/server", headers })).json().id;
    const ref = (origin: object, path?: string, server = serverId) =>
      Buffer.from(JSON.stringify({ serverId: server, origin, ...(path ? { path } : {}) })).toString(
        "base64url",
      );
    const nodeReference = ref({ kind: "node", id: nodeId });
    const agentReference = ref({ kind: "agent", id: reader.id }, `intrica-file:${nodeId}`);
    const download = (reference: string) =>
      app.inject({ url: `/api/v2/files/download?reference=${reference}`, headers });
    expect((await download(agentReference)).statusCode).toBe(403);
    const link = await connect(reader.id, nodeId);
    for (const change of [() => writeFile(path, "replacement"), () => rm(path)]) {
      await change();
      const saved = await download(nodeReference);
      expect(saved.statusCode).toBe(200);
      expect(saved.rawPayload).toEqual(original);
      expect(saved.headers.etag).toBe(`"sha256-${node.resource!.snapshot!.hash}"`);
      expect((await download(agentReference)).rawPayload).toEqual(original);
    }
    const preview = await app.inject({
      url: `/api/v2/files/preview?reference=${nodeReference}`,
      headers,
    });
    expect(preview.json()).toMatchObject({ text: original.toString(), serverId });
    await k.graph.deleteLink(link.edge.id, { idempotencyKey: key() });
    expect((await download(agentReference)).statusCode).toBe(403);
    expect(
      (await download(ref({ kind: "node", id: nodeId }, undefined, "another-server"))).statusCode,
    ).toBe(403);
    const fresh = await session(reader.id);
    const textOnly = await fresh.call("create_artifact", {
      kind: "text",
      title: "No attachment",
      text: "plain report",
    });
    const invalid = await fresh.call("report_result", {
      message: "missing file",
      fileIds: [textOnly.value.id],
    });
    expect(invalid.result.isError).toBe(true);
  });
  it("PDF01 upgrades schema 7 to 8 through buildServer while preserving existing nodes", async () => {
    expect(priorVersion).toBe(7);
    expect((await k.db.pool.query("select version from schema_info")).rows[0].version).toBe(10);
    expect(await k.graph.queries.node("pdf-upgrade-text")).toMatchObject({
      kind: "text",
      title: "old text",
      text: "existing evidence",
      canvasId: "pdf-upgrade-board",
    });
    await k.db.migrate();
    expect(await k.graph.queries.node("pdf-upgrade-text")).toMatchObject({
      text: "existing evidence",
    });
    const added = await pdfNode("pdf-upgrade-board");
    expect(added).toMatchObject({ kind: "pdf", assetId: pdfAsset.assetId });
  });

  it("PDF02 stores original bytes and a distinct PNG thumbnail and serves each with its correct MIME", async () => {
    expect(pdfAsset).toMatchObject({ mime: "application/pdf", pageCount: 2, assetVersion: 1 });
    const resolved = await k.assets.resolve(pdfAsset.assetId);
    expect(resolved?.data).toEqual(PDF_FIXTURE);
    expect(resolved?.mime).toBe("application/pdf");
    const original = await app.inject({
      method: "GET",
      url: `/api/v2/assets/${pdfAsset.assetId}`,
      headers,
    });
    expect(original.statusCode).toBe(200);
    expect(original.headers["content-type"]).toContain("application/pdf");
    expect(original.rawPayload).toEqual(PDF_FIXTURE);
    const thumb = await app.inject({
      method: "GET",
      url: `/api/v2/assets/${pdfAsset.assetId}?variant=thumb`,
      headers,
    });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers["content-type"]).toContain("image/png");
    expect(thumb.rawPayload.subarray(0, 8)).toEqual(PNG.subarray(0, 8));
    expect(thumb.rawPayload).not.toEqual(PDF_FIXTURE);
    expect((await k.assets.put(PDF_FIXTURE)).assetId).toBe(pdfAsset.assetId);
    await expect(k.assets.put(Buffer.from("%PDF-invalid"))).rejects.toMatchObject({
      code: "ASSET_INVALID",
    });
  });

  it("PDF03 uploads actual multipart PDF and refuses missing/mismatched asset types", async () => {
    const boundary = `intrica-${key()}`;
    const response = await app.inject({
      method: "POST",
      url: "/api/v2/assets",
      headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="evidence.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
        ),
        PDF_FIXTURE,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      assetId: pdfAsset.assetId,
      mime: "application/pdf",
      pageCount: 2,
    });
    const parentId = await canvas();
    const image = await k.assets.put(PNG);
    for (const input of [
      { kind: "pdf" as const },
      { kind: "pdf" as const, assetId: image.assetId },
      { kind: "image" as const, assetId: pdfAsset.assetId },
      { kind: "text" as const, assetId: pdfAsset.assetId },
      { kind: "todo" as const, assetId: pdfAsset.assetId },
      { kind: "agent" as const, assetId: pdfAsset.assetId },
    ])
      await expect(
        k.graph.createNode({ ...input, parentId, position, idempotencyKey: key() }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await pdfNode(parentId)).kind).toBe("pdf");
  });

  it("PDF04 authenticated page API returns actual page text/images and explicit bounds", async () => {
    const document = await pdfNode(await canvas());
    const path = `/api/v2/nodes/${document.id}/pdf`;
    const first = await app.inject({ method: "GET", url: `${path}?page=1`, headers });
    expect(first.statusCode).toBe(200);
    const a = first.json();
    expect(a).toMatchObject({
      mediaType: "pdf",
      page: 1,
      pageCount: 2,
      nextPage: 2,
      hasText: true,
    });
    expect(a.text).toContain("INTRICA-PDF-042");
    expect(Buffer.from(a.image, "base64").subarray(0, 8)).toEqual(PNG.subarray(0, 8));
    const second = await app.inject({ method: "GET", url: `${path}?page=2`, headers });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ page: 2, nextPage: null, hasText: false, text: "" });
    expect(second.json().image).not.toBe(a.image);
    expect(second.json().note).toContain("no OCR");
    const textOnly = await app.inject({
      method: "GET",
      url: `${path}?page=1&render=false`,
      headers,
    });
    expect(textOnly.statusCode).toBe(200);
    expect(textOnly.json().image).toBeUndefined();
    const segment = await app.inject({
      method: "GET",
      url: `${path}?page=1&render=false&characterOffset=5&characterLimit=11`,
      headers,
    });
    expect(segment.statusCode).toBe(200);
    expect(segment.json().text).toBe(textOnly.json().text.slice(5, 16));
    expect(segment.json().nextCharOffset).toBe(16);
    expect((await app.inject({ method: "GET", url: `${path}?page=3`, headers })).statusCode).toBe(
      422,
    );
    expect((await app.inject({ method: "GET", url: `${path}?page=0`, headers })).statusCode).toBe(
      400,
    );
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(401);
  });

  it("PDF05 connected Agent continues through PDF pages and preserves node identity and image content", async () => {
    const c = await canvas(),
      reader = await agent(c),
      document = await pdfNode(c);
    await connect(reader.id, document.id);
    const child = await session(reader.id);
    const first = await child.call("read", {
      target: { kind: "node", nodeId: document.id },
      page: 1,
    });
    expect(first.result.isError).not.toBe(true);
    expect(first.value).toMatchObject({
      id: document.id,
      nodeId: document.id,
      parentId: document.parentId,
      kind: "pdf",
      title: document.title,
      revision: document.revision,
      field: "pdf",
      page: 1,
      pageCount: 2,
      nextCursor: expect.any(String),
    });
    expect(first.value.content).toContain("INTRICA-PDF-042");
    expect(hasImage(first.result)).toBe(true);
    const text = await child.call("read", {
      target: { kind: "node", nodeId: document.id },
      page: 1,
      mode: "text",
    });
    expect(text.value.content).toBe(first.value.content);
    expect(hasImage(text.result)).toBe(false);
    const last = await child.call("read", {
      target: { kind: "node", nodeId: document.id },
      cursor: first.value.nextCursor,
    });
    expect(last.value).toMatchObject({ page: 2, nextCursor: null, hasText: false, content: "" });
    expect(hasImage(last.result)).toBe(true);
  });

  it("PDF12 generation rejects selected, connected, descendant and scope PDFs before enqueueing", async () => {
    const c = await canvas(),
      document = await pdfNode(c);
    const source = (
      await k.graph.createNode({
        kind: "text",
        parentId: c,
        title: "Source notes",
        text: "Only this text is generation-ready",
        position,
        idempotencyKey: key(),
      })
    ).node;
    const base = {
      scopeId: c,
      includeConnected: false,
      includeDescendants: [] as string[],
      instruction: "Summarize the actual evidence",
    };
    const rejected = async (intent: Parameters<Kernel["generation"]["preview"]>[0]) => {
      expect((await k.generation.preview(intent)).preview.blockedPdfNodeIds.length).toBeGreaterThan(
        0,
      );
      await expect(k.generation.create({ ...intent, idempotencyKey: key() })).rejects.toMatchObject(
        {
          code: "VALIDATION",
          message: expect.stringContaining("read"),
        },
      );
    };
    for (const type of ["expand", "deepen", "compress"] as const)
      await rejected({
        ...base,
        type,
        selection: type === "compress" ? [document.id, source.id] : [document.id],
      });
    await connect(source.id, document.id);
    await rejected({ ...base, type: "expand", selection: [source.id], includeConnected: true });
    await pdfNode(source.id);
    await rejected({
      ...base,
      type: "expand",
      selection: [source.id],
      includeDescendants: [source.id],
    });
    const nested = (
      await k.graph.createNode({
        kind: "text",
        parentId: document.id,
        title: "Notes inside a PDF",
        position,
        idempotencyKey: key(),
      })
    ).node;
    await rejected({ ...base, type: "expand", scopeId: document.id, selection: [nested.id] });
    const allowed = await k.generation.preview({ ...base, type: "expand", selection: [source.id] });
    expect(allowed.preview.draft.nodes.map((node) => node.id)).toEqual([source.id]);
    expect(
      (await k.db.pool.query("select id from runs where canvas_id=$1 and kind='generation'", [c]))
        .rows,
    ).toEqual([]);
  });

  it("PDF13 legacy non-PDF nodes never send PDF bytes as image tool content", async () => {
    const c = await canvas(),
      reader = await agent(c);
    const legacy = (
      await k.graph.createNode({
        kind: "text",
        parentId: c,
        title: "Legacy mismatched attachment",
        position,
        idempotencyKey: key(),
      })
    ).node;
    await k.db.pool.query("update nodes set asset_id=$2 where id=$1", [
      legacy.id,
      pdfAsset.assetId,
    ]);
    await connect(reader.id, legacy.id);
    const child = await session(reader.id);
    const read = await child.call("read", { target: { kind: "node", nodeId: legacy.id } });
    expect(read.result.isError).toBe(true);
    expect(hasImage(read.result)).toBe(false);
    expect(JSON.stringify(read.result)).not.toContain(PDF_FIXTURE.toString("base64"));
  });

  it("PDF06 unauthorized and revoked resource reads never disclose PDF text or images", async () => {
    const c = await canvas(),
      reader = await agent(c),
      document = await pdfNode(c);
    const child = await session(reader.id);
    const denied = await child.call("read", {
      target: { kind: "node", nodeId: document.id },
      page: 1,
    });
    expect(denied.waiting).toBe("approval");
    expect(hasImage(denied.result)).toBe(false);
    expect(JSON.stringify(denied.result)).not.toContain("INTRICA-PDF-042");
    const edge = await connect(reader.id, document.id);
    expect(
      (
        await child.call("read", {
          target: { kind: "node", nodeId: document.id },
          page: 1,
          mode: "text",
        })
      ).value.content,
    ).toContain("INTRICA-PDF-042");
    await k.graph.deleteLink(edge.edge.id, { idempotencyKey: key() });
    expect(await grantsFor(k.db.pool, reader.id)).toHaveLength(0);
    await expect(
      child.call("read", { target: { kind: "node", nodeId: document.id }, page: 2 }),
    ).rejects.toMatchObject({
      code: "STALE_EXECUTION",
    });
    await k.runs.fail(child.run, new Error("fixture acknowledges revocation cancellation"));
    const fresh = await session(reader.id);
    const revoked = await fresh.call("read", {
      target: { kind: "node", nodeId: document.id },
      page: 2,
    });
    expect(revoked.waiting).toBe("approval");
    expect(hasImage(revoked.result)).toBe(false);
    expect(revoked.value.pageCount).toBeUndefined();
  });

  it("PDF07 a frozen host-read approval resumes only the same page/mode and never creates a persistent grant", async () => {
    const reader = await agent(await canvas()),
      child = await session(reader.id);
    const path = join(files, `${key()}.bin`);
    await writeFile(path, PDF_FIXTURE);
    const args = { target: { kind: "path", path }, page: 2, mode: "auto" };
    const pending = await child.call("read", args);
    expect(pending.waiting).toBe("approval");
    expect(hasImage(pending.result)).toBe(false);
    const request = await approve(pending.value.requestId);
    expect(request.action).toMatchObject({
      kind: "host",
      tool: "read",
      args: { path, page: 2, mode: "auto" },
    });
    await expect(child.call("read", { ...args, page: 1 }, pending.logical)).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    const resumed = await child.call("read", args, pending.logical);
    expect(resumed.result.isError).not.toBe(true);
    expect(resumed.value).toMatchObject({
      mediaType: "pdf",
      page: 2,
      pageCount: 2,
      hasText: false,
    });
    expect(hasImage(resumed.result)).toBe(true);
    expect(await grantsFor(k.db.pool, reader.id)).toHaveLength(0);
    expect((await child.call("read", args)).waiting).toBe("approval");
    expect(
      (await child.call("read", { target: { kind: "path", path }, page: 1, mode: "text" })).waiting,
    ).toBe("approval");
  });

  it("PDF08 non-vision models retain PDF text in host and node reads but reject image requests", async () => {
    const c = await canvas(),
      reader = await agent(c),
      document = await pdfNode(c);
    await connect(reader.id, document.id);
    const child = await session(reader.id, false);
    const scratch = (await k.host.scope(child.actor)).scratch;
    const path = join(scratch, "evidence.pdf");
    await writeFile(path, PDF_FIXTURE);
    for (const [name, args] of [
      ["read", { target: { kind: "path", path }, page: 1 }],
      ["read", { target: { kind: "node", nodeId: document.id }, page: 1 }],
    ] as const) {
      const automatic = await child.call(name, args);
      expect(automatic.result.isError).not.toBe(true);
      expect(hasImage(automatic.result)).toBe(false);
      expect(JSON.stringify(automatic.value)).toContain("INTRICA-PDF-042");
      const image = await child.call(name, { ...args, mode: "image" });
      expect(image.result.isError).toBe(true);
      expect(hasImage(image.result)).toBe(false);
      expect(JSON.stringify(image.result)).toContain("不支持图像");
    }
    const graphics = await child.call("read", {
      target: { kind: "path", path },
      page: 2,
      mode: "text",
    });
    expect(graphics.value).toMatchObject({ hasText: false, text: "" });
    expect(graphics.value.note).toContain("no OCR");
  });

  it("PDF09 path-backed PDF nodes use the same read authorization and revoke the matching host file", async () => {
    const c = await canvas(),
      reader = await agent(c);
    const path = join(files, `${key()}.pdf`);
    await writeFile(path, PDF_FIXTURE);
    const document = (
      await k.graph.createNode({
        kind: "pdf",
        parentId: c,
        title: "Linked server PDF",
        resource: { type: "file", path },
        position,
        idempotencyKey: key(),
      })
    ).node;
    const edge = await connect(reader.id, document.id);
    const child = await session(reader.id);
    const pageApi = await app.inject({
      method: "GET",
      url: `/api/v2/nodes/${document.id}/pdf?page=1&render=false`,
      headers,
    });
    expect(pageApi.statusCode).toBe(200);
    expect(pageApi.json().text).toContain("INTRICA-PDF-042");
    for (const url of [
      `/api/v2/nodes/${document.id}/pdf?page=1&render=false&characterOffset=5&characterLimit=11`,
      `/api/v2/workspace/pdf?path=${encodeURIComponent(path)}&page=1&render=false&characterOffset=5&characterLimit=11`,
    ]) {
      const segment = await app.inject({ method: "GET", url, headers });
      expect(segment.statusCode).toBe(200);
      expect(segment.json().text).toBe(pageApi.json().text.slice(5, 16));
      expect(segment.json().nextCharOffset).toBe(16);
    }
    const content = await child.call("read", {
      target: { kind: "node", nodeId: document.id },
      page: 1,
      mode: "text",
    });
    expect(content.result.isError).not.toBe(true);
    expect(content.value.content).toContain("INTRICA-PDF-042");
    const file = await child.call("read", { target: { kind: "path", path }, page: 2 });
    expect(file.waiting).toBeUndefined();
    expect(file.value.page).toBe(2);
    await k.graph.deleteLink(edge.edge.id, { idempotencyKey: key() });
    await expect(
      child.call("read", { target: { kind: "path", path }, page: 1 }),
    ).rejects.toMatchObject({
      code: "STALE_EXECUTION",
    });
    await k.runs.fail(child.run, new Error("fixture acknowledges revocation cancellation"));
    const fresh = await session(reader.id);
    expect((await fresh.call("read", { target: { kind: "path", path }, page: 1 })).waiting).toBe(
      "approval",
    );
  });

  it("PDF10 image approvals resume through reconstructed definitions without repeating effects", async () => {
    const reader = await agent(await canvas()),
      child = await session(reader.id);
    expect(
      child.tools.filter((tool) => tool.modelVisible !== false).map((tool) => tool.name),
    ).toContain("read");
    const path = join(files, `${key()}.png`);
    await writeFile(path, PNG);
    const args = { target: { kind: "path", path }, frame: 0 };
    const pending = await child.call("read", args);
    expect(pending.waiting).toBe("approval");
    await approve(pending.value.requestId);
    const recoveredDefinitions = await k.tools.create(child.ctx, child.input);
    const recovered = await child.call("read", args, pending.logical, recoveredDefinitions);
    expect(recovered.result.isError).not.toBe(true);
    expect(hasImage(recovered.result)).toBe(true);
    const rows = (
      await k.db.pool.query(
        "select name,args,state from tool_calls where run_id=$1 and logical_call_id=$2",
        [child.run.id, pending.logical],
      )
    ).rows;
    expect(rows).toEqual([{ name: "read", args, state: "succeeded" }]);
    expect(await grantsFor(k.db.pool, reader.id)).toHaveLength(0);
  });

  it("PDF11 page/frame/mode validation rejects unsupported combinations without treating PDFs as binary text", async () => {
    const reader = await agent(await canvas()),
      child = await session(reader.id);
    const path = join((await k.host.scope(child.actor)).scratch, "document-without-extension");
    await writeFile(path, PDF_FIXTURE);
    for (const args of [
      { target: { kind: "path", path }, page: 0 },
      { target: { kind: "path", path }, page: 3 },
      { target: { kind: "path", path }, frame: 0 },
    ]) {
      const rejected = await child.call("read", args);
      expect(rejected.result.isError).toBe(true);
      expect(hasImage(rejected.result)).toBe(false);
    }
    const text = await child.call("read", {
      target: { kind: "path", path },
      page: 1,
      mode: "text",
    });
    expect(text.result.isError).not.toBe(true);
    expect(text.value.text).toContain("INTRICA-PDF-042");
    expect(text.value.text).not.toContain("%PDF-");
    expect(hasImage(text.result)).toBe(false);
  });
});
