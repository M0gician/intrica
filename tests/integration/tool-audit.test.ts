import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { DomainError } from "../../apps/server/dist/adapters/postgres/database.js";
import {
  type ExecutionTool,
  invokeTool,
  result,
} from "../../apps/server/dist/modules/execution/tool-calls.js";

const key = () => randomUUID();
const database = `intrica_tool_audit_${key().replaceAll("-", "")}`;
const url = new URL(process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres");
let admin: pg.Client, app: Awaited<ReturnType<typeof buildServer>>, k: Kernel, directory: string;
beforeAll(async () => {
  admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  await admin.query(`create database ${database}`);
  url.pathname = `/${database}`;
  directory = await mkdtemp(join(tmpdir(), "intrica-tool-audit-"));
  app = await buildServer({
    databaseUrl: url.href,
    dataDir: directory,
    worker: false,
    model: { kind: "mock", streamDelayMs: 0, supportsVision: false },
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
async function session() {
  const canvasId = (await k.graph.createCanvas({ title: "Tool ledger", idempotencyKey: key() }))
    .node.id;
  await k.conversations.submit({ canvasId, message: "Inspect the supplied evidence", key: key() });
  const run = (await k.runs.claim("tool-audit"))!;
  const ctx = { run, store: k.runs, signal: new AbortController().signal, progress() {} };
  const rows = async () =>
    (
      await k.db.pool.query("select * from tool_calls where run_id=$1 order by created_at,id", [
        run.id,
      ])
    ).rows;
  return { ctx, rows };
}
function definition(execute = vi.fn(async () => result({ done: true }))): ExecutionTool {
  return {
    name: "inspect",
    label: "inspect",
    description: "Inspect a typed target",
    effect: "read",
    parameters: Type.Object(
      { target: Type.Object({ id: Type.String() }) },
      { additionalProperties: false },
    ),
    execute,
  };
}
it("invalid and unknown calls have immutable receipts, structured errors and repair lineage", async () => {
  const s = await session(),
    tool = definition();
  const logical = key(),
    args = { target: "not an object" };
  const first = await invokeTool(s.ctx, tool, logical, args);
  expect(first.result.isError).toBe(true);
  expect(JSON.parse((first.result.content[0] as { text: string }).text)).toMatchObject({
    executed: false,
    issues: [{ path: "/target", expected: "object", actual: "string" }],
  });
  const failed = (await s.rows())[0];
  expect(failed).toMatchObject({
    state: "failed",
    audit: { phase: "validation", executed: false, inputError: true },
  });
  expect(tool.execute).not.toHaveBeenCalled();
  expect((await invokeTool(s.ctx, tool, logical, args)).result).toEqual(first.result);
  expect(await s.rows()).toHaveLength(1);
  await expect(
    invokeTool(s.ctx, tool, logical, { target: { id: "changed" } }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await invokeTool(s.ctx, tool, key(), { target: { id: "authorized-example" } });
  expect((await s.rows())[1]).toMatchObject({
    retry_of: failed.id,
    state: "succeeded",
    audit: { phase: "complete", executed: true },
  });
  expect(tool.execute).toHaveBeenCalledTimes(1);
  await invokeTool(s.ctx, "unavailable_tool", key(), undefined);
  expect((await s.rows())[2]).toMatchObject({
    name: "unavailable_tool",
    effect_class: "none",
    state: "failed",
  });
  expect(
    (
      await k.db.pool.query("select * from run_events where run_id=$1 and type='tool'", [
        s.ctx.run.id,
      ])
    ).rows,
  ).toHaveLength(4);
});
it("preflight exceptions are recorded and cannot become ambiguous executed operations", async () => {
  const s = await session(),
    tool = definition();
  tool.normalize = async () => {
    throw new Error("local preparation error");
  };
  await expect(invokeTool(s.ctx, tool, key(), { target: { id: "entry" } })).rejects.toThrow(
    "local preparation error",
  );
  expect((await s.rows())[0]).toMatchObject({
    state: "prepared",
    audit: { phase: "validation", executed: false, errorCode: "TOOL_PREPARATION_FAILED" },
  });
  delete tool.normalize;
  tool.prepare = async () => {
    throw new DomainError("FORBIDDEN", "No read grant");
  };
  await invokeTool(s.ctx, tool, key(), { target: { id: "entry" } });
  expect((await s.rows())[1]).toMatchObject({
    state: "failed",
    audit: { phase: "authorization", executed: false, errorCode: "FORBIDDEN" },
  });
  expect(tool.execute).not.toHaveBeenCalled();
});
it("repeated input failures stop at a finite repair limit while valid independent tools remain available", async () => {
  const s = await session(),
    tool = definition();
  for (let i = 0; i <= k.runs.limits.toolInputRepairs; i++) {
    const outcome = await invokeTool(s.ctx, tool, key(), { target: `attempt-${i}` });
    expect(outcome.waiting).toBe(i === k.runs.limits.toolInputRepairs ? "tool_input" : undefined);
  }
  const other = { ...definition(), name: "independent" };
  expect(
    (await invokeTool(s.ctx, other, key(), { target: { id: "another-work-item" } })).result.isError,
  ).not.toBe(true);
  expect(other.execute).toHaveBeenCalledTimes(1);
});
