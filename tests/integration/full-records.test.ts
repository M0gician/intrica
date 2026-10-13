import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

const key = () => randomUUID();
const name = `intrica_records_${key().replaceAll("-", "")}`;
let app: Awaited<ReturnType<typeof buildServer>>,
  admin: pg.Client,
  directory: string,
  agentId: string,
  conversationId: string;
const token = key();
beforeAll(async () => {
  const url = new URL(process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres");
  admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  await admin.query(`create database ${name}`);
  url.pathname = `/${name}`;
  directory = await mkdtemp(join(tmpdir(), "intrica-records-"));
  app = await buildServer({
    databaseUrl: url.href,
    dataDir: directory,
    accessToken: token,
    worker: false,
    model: { kind: "mock", streamDelayMs: 0, supportsVision: false },
  });
  await app.ready();
  const k = app.kernel;
  const board = (await k.graph.createCanvas({ title: "records", idempotencyKey: key() })).node;
  agentId = (
    await k.graph.createNode({
      kind: "agent",
      parentId: board.id,
      position: { x: 0, y: 0, width: 220, height: 300 },
      agent: { persona: "", role: "read", enabled: false },
      idempotencyKey: key(),
    })
  ).node.id;
  conversationId = (await k.conversations.read.forAgent(agentId)).id;
});
afterAll(async () => {
  await app?.close();
  await admin.query(`drop database if exists ${name} with(force)`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
});
const request = (path: string) =>
  app.inject({
    method: "GET",
    url: `/api/v2/canvas-agents/${agentId}${path}`,
    headers: { authorization: `Bearer ${token}` },
  });
async function append(role: string, data: object) {
  const k: Kernel = app.kernel;
  const c = await k.conversations.read.forAgent(agentId);
  return Number(
    await k.db.canvas(c.canvas_id, (tx) =>
      k.conversations.append(tx, conversationId, key(), role, data),
    ),
  );
}

it.each([
  { text: "", thinking: "" },
  { text: "x".repeat(2000), thinking: "" },
  { text: "", thinking: "思".repeat(2001) },
  { text: "文".repeat(2001), thinking: "t".repeat(2001) },
])(
  "separates field truncation and returns matching full versions for $text.length/$thinking.length",
  async (data) => {
    const seq = await append("assistant", data);
    const feed = (await request("")).json();
    const preview = feed.events.find((r: any) => r.seq === seq);
    expect(preview.data.truncatedFields).toEqual({
      text: data.text.length > 2000,
      thinking: data.thinking.length > 2000,
      result: false,
    });
    const full = (await request(`/events/${seq}`)).json();
    expect(full.recordVersion).toBe(preview.recordVersion);
    expect(full.data).toMatchObject({ ...data, truncated: false, truncatedFields: {} });
    await app.kernel.db.pool.query(
      "update messages set content=jsonb_set(content,'{text}',to_jsonb($3::text)) where conversation_id=$1 and seq=$2",
      [conversationId, seq, "changed"],
    );
    expect((await request(`/events/${seq}`)).json().recordVersion).not.toBe(full.recordVersion);
  },
);

it("tracks current tool content independently of callback prose and emits a new version after completion", async () => {
  const k = app.kernel,
    c = await k.conversations.read.forAgent(agentId);
  await k.conversations.submit({
    canvasId: c.canvas_id,
    agentId,
    message: "record fixture",
    key: key(),
  });
  const run = (await k.runs.claim("records"))!,
    callId = key();
  await k.db.pool.query(
    "insert into tool_calls(id,run_id,attempt_id,logical_call_id,name,args,args_hash,effect_class,state,result) values($1,$2,$3,$4,'bash','{}','fixture','external','succeeded',$5)",
    [
      callId,
      run.id,
      run.attemptId,
      key(),
      JSON.stringify({ content: [{ type: "text", text: "short" }] }),
    ],
  );
  const seq = await append("tool_update", {
    callId,
    text: "notice".repeat(500),
    status: "succeeded",
  });
  const first = (await request("")).json().events.find((r: any) => r.seq === seq);
  expect(first.data.truncatedFields).toMatchObject({ text: true, result: false });
  const result = { content: [{ type: "text", text: `${"long".repeat(5000)}RESULT_TAIL` }] };
  await k.db.pool.query(
    "update tool_calls set result=$2,updated_at=clock_timestamp() where id=$1",
    [callId, JSON.stringify(result)],
  );
  const next = (await request("")).json().events.find((r: any) => r.seq === seq);
  expect(next.data.truncatedFields.result).toBe(true);
  expect(next.recordVersion).not.toBe(first.recordVersion);
  const full = (await request(`/events/${seq}`)).json();
  expect(full.recordVersion).toBe(next.recordVersion);
  expect(full.data.result).toEqual(result);
  expect(full.data.truncated).toBe(false);
  expect(Object.values(full.data.truncatedFields).some(Boolean)).toBe(false);
  expect(
    (await app.inject({ method: "GET", url: `/api/v2/canvas-agents/${agentId}/events/${seq}` }))
      .statusCode,
  ).toBe(401);
});
