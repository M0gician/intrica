import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRole } from "@intrica/contracts";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import type { Lease } from "../../../apps/server/dist/modules/execution/store.js";
import { invokeTool } from "../../../apps/server/dist/modules/execution/tool-calls.js";
import type { ExecutionContext } from "../../../apps/server/dist/modules/execution/worker.js";
import type { ToolSet } from "../../../apps/server/dist/modules/work/tools.js";
import { consumeInput } from "./tool-session.js";

const key = () => randomUUID();
const database = `intrica_redesign_${key().replaceAll("-", "")}`;
let app: Awaited<ReturnType<typeof buildServer>>, k: Kernel, admin: pg.Client;
let directory: string, board: string;
const position = { x: 0, y: 0, width: 220, height: 300 };
beforeAll(async () => {
  const url = new URL(process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres");
  admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  await admin.query(`create database ${database}`);
  url.pathname = `/${database}`;
  directory = await realpath(await mkdtemp(join(tmpdir(), "intrica-reliability-")));
  app = await buildServer({
    databaseUrl: url.href,
    dataDir: directory,
    accessToken: key(),
    worker: false,
    model: { kind: "mock", streamDelayMs: 0, supportsVision: true },
  });
  await app.ready();
  k = app.kernel;
});
beforeEach(async () => {
  board = (await k.graph.createCanvas({ title: "Redesign", idempotencyKey: key() })).node.id;
});
afterEach(async () => {
  await k.db.pool.query("update approvals set status='cancelled' where status='pending'");
  await k.db.pool.query(
    "update runs set state='cancelled' where state in('queued','running','waiting')",
  );
  await k.db.pool.query("update message_deliveries set tracking_stopped=true");
  await k.db.pool.query("update conversations set consumed_message_seq=message_seq");
  await k.db.pool.query("update schedules set enabled=false");
});
afterAll(async () => {
  await app?.close();
  await admin.query(`drop database if exists ${database} with(force)`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
});
async function agent(parentId = board, role: AgentRole = "write") {
  return (
    await k.graph.createNode({
      kind: "agent",
      title: "Member",
      parentId,
      position,
      agent: { role, persona: "", enabled: false },
      idempotencyKey: key(),
    })
  ).node;
}
async function start(agentId: string) {
  const submitted = await k.conversations.submit({
    canvasId: board,
    agentId,
    message: "verify",
    key: key(),
  });
  const run: Lease = (await k.runs.claim("reliability"))!;
  expect(run.id).toBe(submitted.run.id);
  const ctx: ExecutionContext = {
    run,
    store: k.runs,
    signal: new AbortController().signal,
    progress() {},
  };
  const tools: ToolSet = await k.tools.create(ctx, run.frozen_input);
  return {
    run,
    ctx,
    tools,
    actor: { kind: "agent" as const, agentId, runId: run.id, epoch: run.epoch },
    async call(name: string, args: object, logical = key()) {
      const response = await invokeTool(
        ctx,
        tools.find((t) => t.name === name) ?? name,
        logical,
        args,
      );
      const raw = (response.result.content[0] as { text: string }).text;
      let value: any;
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
      return { ...response, value, logical };
    },
  };
}
async function consume(s: Awaited<ReturnType<typeof start>>) {
  return consumeInput(k, s);
}

export { agent, board, consume, k, key, start };
