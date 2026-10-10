import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { invokeTool } from "../../apps/server/dist/modules/execution/tool-calls.js";

const key = () => randomUUID();
const database = `intrica_media_environments_${key().replaceAll("-", "")}`;
const url = new URL(process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres");
let admin: pg.Client, app: Awaited<ReturnType<typeof buildServer>>, k: Kernel, directory: string;
beforeAll(async () => {
  admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  await admin.query(`create database ${database}`);
  url.pathname = `/${database}`;
  directory = await mkdtemp(join(tmpdir(), "intrica-message-waits-"));
  app = await buildServer({
    databaseUrl: url.href,
    dataDir: directory,
    worker: false,
    model: { kind: "mock", streamDelayMs: 0, supportsVision: true },
  });
  await app.ready();
  k = app.kernel;
});
afterEach(async () => {
  await k.db.pool.query(
    "update runs set state='cancelled' where state in('queued','running','waiting')",
  );
  await k.db.pool.query(
    "update messages set content=content||'{\"closed\":true}' where consumed_run_id is null",
  );
});
afterAll(async () => {
  await app?.close();
  await admin.query(`drop database if exists ${database} with(force)`);
  await admin.end();
  if (directory) await rm(directory, { recursive: true, force: true });
});

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQMgkTMgljgFAAEA4CcV2GZ44AAAAASUVORK5CYII=",
  "base64",
);
const { PDF_FIXTURE }: { PDF_FIXTURE: Buffer } = await import(
  new URL("../fixtures/pdf.mjs", import.meta.url).href
);
async function session() {
  const canvasId = (
    await k.graph.createCanvas({ title: "Media and runtimes", idempotencyKey: key() })
  ).node.id;
  const files = await k.host.workspace(canvasId);
  await k.conversations.submit({
    canvasId,
    message: "Inspect artifacts and reuse verified runtime references",
    key: key(),
  });
  const run = (await k.runs.claim("media-env"))!;
  const ctx = { run, store: k.runs, signal: new AbortController().signal, progress() {} };
  const tools = await k.tools.create(ctx, run.frozen_input);
  const call = async (name: string, args: object) => {
    const out = await invokeTool(ctx, tools.find((t) => t.name === name)!, key(), args);
    return { ...out, value: JSON.parse((out.result.content[0] as any).text) };
  };
  return { canvasId, files, run, ctx, tools, call };
}
it.each([
  { extension: "png", bytes: png },
  { extension: "pdf", bytes: PDF_FIXTURE },
  {
    extension: "svg",
    bytes: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="9"><rect width="8" height="9" fill="red"/></svg>',
    ),
  },
])(
  "node snapshots and paths share bounded media reads for $extension and retain original source hashes",
  async ({ extension, bytes }) => {
    const s = await session(),
      path = join(s.files, `source.${extension}`);
    await writeFile(path, bytes);
    const file = await s.call("read", { target: { kind: "path", path } });
    const saved = await s.call("create_artifact", {
      kind: "text",
      title: "Published media",
      text: "Evidence",
      path,
    });
    const node = await s.call("read", { target: { kind: "node", nodeId: saved.value.id } });
    expect(node.result.isError).not.toBe(true);
    expect(node.value.contentHash).toBe(file.value.contentHash);
    expect(node.value.contentHash).toBe(saved.value.attachment.snapshot.hash);
    expect(node.value.snapshotVersion).toBe(saved.value.attachment.snapshot.assetId);
    const nodeImages = await k.runs.media!.hydrate(node.result.content, s.run.subject_id);
    const pathImages = await k.runs.media!.hydrate(file.result.content, s.run.subject_id);
    expect(nodeImages.filter((p) => p.type === "image").map((p: any) => p.data)).toEqual(
      pathImages.filter((p) => p.type === "image").map((p: any) => p.data),
    );
    await writeFile(path, "different bytes under the same name");
    const original = await s.call("read", { target: { kind: "node", nodeId: saved.value.id } });
    expect(original.value.contentHash).toBe(node.value.contentHash);
    expect((await s.call("read", { target: { kind: "path", path } })).value.contentHash).not.toBe(
      node.value.contentHash,
    );
  },
);
it("batch PDF pages and image frames are bounded, and a changed source invalidates its continuation", async () => {
  const s = await session(),
    pdf = join(s.files, "pages.bin");
  await writeFile(pdf, PDF_FIXTURE);
  const batch = await s.call("read", {
    target: { kind: "path", path: pdf },
    pages: [1, 2],
    thumbnail: true,
  });
  expect(batch.value.pages.map((p: any) => p.page)).toEqual([1, 2]);
  expect(batch.result.content.filter((p) => p.type === "image")).toHaveLength(2);
  expect(
    (await s.call("read", { target: { kind: "path", path: pdf }, pages: [1, 2, 3, 4, 5] })).result
      .isError,
  ).toBe(true);
  const text = join(s.files, "document.md");
  await writeFile(text, Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n"));
  const first = await s.call("read", { target: { kind: "path", path: text } });
  expect(first.value.nextCursor).toBeTruthy();
  await writeFile(text, "replaced");
  expect(
    (await s.call("read", { target: { kind: "path", path: text }, cursor: first.value.nextCursor }))
      .value.error,
  ).toBe("TARGET_CHANGED");
});
it("environment references recheck permissions, current executable identity and directory existence", async () => {
  const s = await session(),
    interpreter = join(s.files, "test-runtime");
  await writeFile(interpreter, "#!/bin/sh\nprintf runtime-v1\n");
  await chmod(interpreter, 0o700);
  const registered = await s.call("register_environment", {
    label: "Reusable runtime",
    interpreter,
    cwd: s.files,
    instructions: "Use this runtime for the related task.",
  });
  expect(registered.result.isError).not.toBe(true);
  const ref = { id: registered.value.id, version: registered.value.version };
  expect((await s.call("inspect_environment", ref)).value).toMatchObject({
    grantsAccess: false,
    interpreter,
    cwd: s.files,
  });
  const recipient = (
    await k.graph.createNode({
      kind: "agent",
      parentId: s.canvasId,
      title: "Reader",
      agent: { persona: "", role: "read", enabled: false },
      position: { x: 0, y: 0, width: 220, height: 300 },
      idempotencyKey: key(),
    })
  ).node;
  const sent = await s.call("send_message", {
    target: { kind: "agent", agentId: recipient.id },
    kind: "request",
    message: "Continue related work with this environment reference",
    environmentRefs: [ref],
  });
  expect(sent.result.isError).not.toBe(true);
  const c = await k.conversations.read.forAgent(recipient.id);
  const delivered = (
    await k.db.pool.query(
      "select content from messages where conversation_id=$1 and role='message'",
      [c.id],
    )
  ).rows[0].content;
  expect(delivered.environments[0]).toMatchObject({ ...ref, cwd: s.files, grantsAccess: false });
  const { EnvironmentRegistry } = await import(
    "../../apps/server/dist/adapters/host/environments.js"
  );
  await expect(
    new EnvironmentRegistry(k.host).resolve({ canvasId: s.canvasId, agentId: recipient.id }, ref),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await writeFile(interpreter, "#!/bin/sh\nprintf changed-runtime\n");
  expect((await s.call("inspect_environment", ref)).value.error).toBe("ENVIRONMENT_CHANGED");
  const refreshed = await s.call("register_environment", {
    label: "Rechecked runtime",
    interpreter,
    cwd: s.files,
    instructions: "Runtime was updated; confirm its packages.",
  });
  expect(refreshed.value.version).not.toBe(ref.version);
  await rm(interpreter);
  expect(
    (
      await s.call("inspect_environment", {
        id: refreshed.value.id,
        version: refreshed.value.version,
      })
    ).result.isError,
  ).toBe(true);
});
