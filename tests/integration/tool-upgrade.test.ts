import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { assertFence, digest } from "../../apps/server/dist/adapters/postgres/database.js";
import { invokeTool, result } from "../../apps/server/dist/modules/execution/tool-calls.js";
import { Worker } from "../../apps/server/dist/modules/execution/worker.js";
import { removeAddressedSchema } from "../fixtures/remove-addressed-schema.mjs";

const key = () => randomUUID();
let admin: pg.Client, app: Awaited<ReturnType<typeof buildServer>>, k: Kernel;
let database: string,
  directory: string,
  board: string,
  agentId: string,
  conversationId: string,
  options: any;
beforeAll(async () => {
  admin = new pg.Client({
    connectionString: process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres",
  });
  await admin.connect();
});
beforeEach(async () => {
  database = `intrica_upgrade_${key().replaceAll("-", "")}`;
  await admin.query(`create database ${database}`);
  const url = new URL(process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres");
  url.pathname = `/${database}`;
  directory = await mkdtemp(join(tmpdir(), "intrica-upgrade-"));
  options = {
    databaseUrl: url.href,
    dataDir: directory,
    accessToken: "upgrade-test",
    worker: false,
    model: { kind: "mock", streamDelayMs: 0, supportsVision: false },
  };
  app = await buildServer(options);
  await app.ready();
  k = app.kernel;
  board = (await k.graph.createCanvas({ title: "Upgrade", idempotencyKey: key() })).node.id;
  agentId = (
    await k.graph.createNode({
      kind: "agent",
      parentId: board,
      title: "Author",
      position: { x: 0, y: 0, width: 220, height: 300 },
      agent: {
        role: "write",
        persona: "",
        enabled: true,
        schedule: { cron: "0 9 * * *", timezone: "UTC", prompt: "Review", enabled: true },
      },
      idempotencyKey: key(),
    })
  ).node.id;
  conversationId = (await k.conversations.read.forAgent(agentId)).id;
});
afterEach(async () => {
  await app?.close();
  await admin.query(`drop database if exists ${database} with(force)`);
  await rm(directory, { recursive: true, force: true });
});
afterAll(() => admin.end());

async function run(state = "waiting", reason: string | null = "unknown") {
  const runId = key(),
    attemptId = key();
  const frozen = {
    conversationId,
    agentId,
    selection: [],
    language: "en",
    model: await k.models.capture(),
  };
  await k.db.pool.query(
    `insert into runs(id,canvas_id,subject_id,kind,state,reason,frozen_input,cause_id,epoch,owner_id,lease_until)
     values($1,$2,$3,'conversation',$4,$5,$6,$1,1,$7,now()+interval '5 minutes')`,
    [
      runId,
      board,
      conversationId,
      state,
      reason,
      JSON.stringify(frozen),
      state === "running" ? "old-worker" : null,
    ],
  );
  await k.db.pool.query("insert into attempts(id,run_id,epoch,state) values($1,$2,1,$3)", [
    attemptId,
    runId,
    state === "running" ? "running" : state === "waiting" ? "waiting" : "succeeded",
  ]);
  return { id: runId, attemptId, canvas_id: board, epoch: 1 };
}
async function call(
  r: Awaited<ReturnType<typeof run>>,
  name: string,
  state: string,
  extra: Record<string, any> = {},
) {
  const callId = key(),
    providerId = key(),
    args = extra.args ?? {
      path: join(directory, "result.txt"),
      oldText: "before",
      newText: "after",
    };
  const logical = extra.logical ?? `turn:${providerId}`;
  const output = extra.result === undefined ? null : extra.result;
  await k.db.pool.query(
    `insert into tool_calls(id,run_id,attempt_id,logical_call_id,name,args,args_hash,effect_class,state,is_async,result)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      callId,
      r.id,
      r.attemptId,
      logical,
      name,
      JSON.stringify(args),
      digest(args),
      extra.effect ?? "external",
      state,
      extra.async ?? false,
      output && JSON.stringify(output),
    ],
  );
  if (extra.dispatched)
    await k.db.canvas(board, (tx) =>
      k.runs.eventTx(tx, r.id, r.attemptId, "tool", { callId, status: "running", name }),
    );
  return { id: callId, providerId, logical, args, name };
}
async function checkpoint(calls: Array<{ providerId: string; name: string; args: unknown }>) {
  await k.db.pool.query("update conversations set checkpoint=$2,context=$3 where id=$1", [
    conversationId,
    JSON.stringify([
      { role: "user", content: "Original task", timestamp: 1 },
      {
        role: "assistant",
        content: calls.map((c) => ({
          type: "toolCall",
          id: c.providerId,
          name: c.name,
          arguments: c.args,
        })),
        timestamp: 2,
      },
    ]),
    JSON.stringify({ pendingTurnId: "turn", turnsSinceInput: 1 }),
  ]);
}
async function version(value: 8 | 9) {
  await removeAddressedSchema(k.db.pool);
  await k.db.pool.query(
    "alter table schedules drop column revision, drop column dispatch_state, drop column blocked_reason, drop column delivery_seq, drop column delivery_run_id",
  );
  if (value === 8)
    await k.db.pool.query(
      "drop index runs_handoffs; alter table runs drop column superseded_by_run_id; alter table messages drop column consumed_run_id",
    );
  await k.db.pool.query(
    `alter table schema_info drop constraint schema_info_version_check; update schema_info set version=${value}; alter table schema_info add constraint schema_info_version_check check(version=${value})`,
  );
}
async function reopen() {
  await app.close();
  app = await buildServer(options);
  await app.ready();
  k = app.kernel;
}
const stored = (id: string) =>
  k.db.pool.query("select * from tool_calls where id=$1", [id]).then((r) => r.rows[0]);

it.each([8, 9] as const)(
  "schema %s opens with complete receipts and a conversation-scoped upgrade pause",
  async (schema) => {
    const r = await run("running", null);
    const file = join(directory, "result.txt");
    await writeFile(file, "already committed");
    const success = await call(r, "edit", "succeeded", {
      result: result({ written: true }),
      async: true,
    });
    const prepared = await call(r, "edit", "prepared");
    const dispatched = await call(r, "edit", "prepared", { dispatched: true });
    const pending = await call(r, "request_role", "waiting", { effect: "read", dispatched: true });
    const approval = key();
    await k.db.pool.query(
      `insert into approvals(id,canvas_id,subject_id,origin_call_id,action,basis,status,expires_at,reason)
     values($1,$2,$3,$4,'{"kind":"role","role":"admin"}','{}','pending',now()+interval '1 hour','Permission')`,
      [approval, board, agentId, pending.id],
    );
    await k.db.pool.query("update tool_calls set approval_id=$2 where id=$1", [
      pending.id,
      approval,
    ]);
    const read = await call(r, "read_node", "dispatching", { effect: "read", dispatched: true });
    const uncertain = await call(r, "request_access", "dispatching", {
      effect: "read",
      dispatched: true,
    });
    await checkpoint([success, prepared, dispatched, pending, read, uncertain]);
    await k.db.canvas(board, async (tx) => {
      await k.conversations.append(tx, conversationId, "consumed", "user", { text: "Consumed" });
      await tx.query("update conversations set consumed_message_seq=message_seq where id=$1", [
        conversationId,
      ]);
      await k.conversations.append(tx, conversationId, "unread", "user", {
        text: "Retain this input",
      });
    });
    const schedule = (await k.db.pool.query("select * from schedules where agent_id=$1", [agentId]))
      .rows;
    await version(schema);
    await reopen();
    expect((await k.db.pool.query("select version from schema_info")).rows[0].version).toBe(16);
    expect((await stored(success.id)).result).toEqual(result({ written: true }));
    expect((await stored(prepared.id)).state).toBe("failed");
    expect((await stored(dispatched.id)).state).toBe("unknown");
    expect((await stored(pending.id)).state).toBe("failed");
    expect((await stored(read.id)).state).toBe("failed");
    expect((await stored(uncertain.id)).state).toBe("unknown");
    expect(
      (await k.db.pool.query("select status from approvals where id=$1", [approval])).rows[0]
        .status,
    ).toBe("invalidated");
    expect((await k.graph.queries.node(agentId)).agent!.role).toBe("write");
    expect(
      (await k.db.pool.query("select * from schedules where agent_id=$1", [agentId])).rows,
    ).toEqual(schedule);
    const saved = (
      await k.db.pool.query("select * from conversations where id=$1", [conversationId])
    ).rows[0];
    expect(String(saved.consumed_message_seq)).toBe("1");
    expect(saved.checkpoint.filter((m: any) => m.role === "toolResult")).toHaveLength(6);
    expect(await k.runs.get(r.id)).toMatchObject({
      state: "waiting",
      reason: "tool_contract_upgrade",
      owner_id: null,
      lease_until: null,
      epoch: 2,
    });
    await expect(k.db.transaction((tx) => assertFence(tx, r.id, 1))).rejects.toMatchObject({
      code: "STALE_EXECUTION",
    });
    const notices = (await k.conversations.read.history(conversationId)).filter(
      (m) => m.role === "tool_update",
    );
    expect(notices.find((m) => m.content.callId === success.id)?.content.result).toEqual(
      result({ written: true }),
    );
    const count = (
      await k.db.pool.query("select count(*) from messages where conversation_id=$1", [
        conversationId,
      ])
    ).rows[0].count;
    await k.db.migrate();
    expect(
      (
        await k.db.pool.query("select count(*) from messages where conversation_id=$1", [
          conversationId,
        ])
      ).rows[0].count,
    ).toBe(count);
    expect(await readFile(file, "utf8")).toBe("already committed");
  },
);

it("normal message waiting and terminal undelivered outcomes open without an upgrade pause", async () => {
  const r = await run("waiting", "message");
  const done = await call(r, "create_todo", "succeeded", {
    async: true,
    result: result({ id: "saved-artifact" }),
  });
  await checkpoint([done]);
  await version(9);
  await reopen();
  expect(await k.runs.get(r.id)).toMatchObject({ state: "waiting", reason: "message" });
  expect((await stored(done.id)).delivered_at).toBeTruthy();
  expect(
    (await k.conversations.read.history(conversationId)).some(
      (m) => m.role === "tool_update" && m.content.callId === done.id,
    ),
  ).toBe(true);
});

it("older unknown calls remain reviewable; resolution and explicit continuation are separate", async () => {
  const old = await run("failed", "unknown"),
    first = await call(old, "edit", "unknown", { result: result("No final acknowledgement") });
  await writeFile(first.args.path, "already committed");
  const second = await call(old, "bash", "unknown");
  await checkpoint([first]);
  const later = await run("succeeded", null);
  await version(9);
  await reopen();
  const view = await k.conversations.read.feed(agentId);
  expect(view.unknownTools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: first.id, canRetry: false, runId: old.id }),
      expect.objectContaining({ id: second.id, canRetry: false, runId: old.id }),
    ]),
  );
  expect(await k.runs.get(later.id)).toMatchObject({ state: "succeeded" });
  await expect(
    k.conversations.resolveUnknown(first.id, "retry", "I checked"),
  ).rejects.toMatchObject({ code: "INVALID_STATE" });
  await expect(
    k.conversations.submit({
      canvasId: board,
      agentId,
      resumeRunId: view.runId,
      message: "Continue",
      key: key(),
    }),
  ).rejects.toMatchObject({ code: "INVALID_STATE" });
  await k.conversations.resolveUnknown(
    first.id,
    "abandon",
    "The effect remains uncertain; do not replay it.",
  );
  const savedCheckpoint = (
    await k.db.pool.query("select checkpoint from conversations where id=$1", [conversationId])
  ).rows[0].checkpoint;
  expect(savedCheckpoint.find((m: any) => m.intricaCallId === first.id).content).toEqual(
    (await stored(first.id)).result.content,
  );
  expect(await k.runs.get(old.id)).toMatchObject({
    state: "waiting",
    reason: "tool_contract_upgrade",
  });
  expect(await k.runs.claim("must-not-resume")).toBeNull();
  await expect(
    k.conversations.submit({
      canvasId: board,
      agentId,
      resumeRunId: view.runId,
      message: "Continue",
      key: key(),
    }),
  ).rejects.toMatchObject({ code: "INVALID_STATE" });
  await k.conversations.resolveUnknown(second.id, "done", "Checked the command output");
  expect(await k.runs.claim("verification-is-not-continuation")).toBeNull();
  const continued = await k.conversations.submit({
    canvasId: board,
    agentId,
    resumeRunId: view.runId,
    message: "Continue with current tools",
    key: key(),
  });
  expect(continued.run.id).not.toBe(old.id);
  expect(continued.run.state).toBe("queued");
  expect((await k.conversations.read.feed(agentId)).unknownTools).toHaveLength(0);
  const current = (await k.runs.claim("current-worker"))!;
  expect(current.id).toBe(continued.run.id);
  await k.worker.handlers.conversation({
    run: current,
    store: k.runs,
    signal: new AbortController().signal,
    progress() {},
  });
  expect(
    (await k.db.pool.query("select name,state from tool_calls where run_id=$1", [current.id])).rows,
  ).toEqual([{ name: "read_canvas", state: "succeeded" }]);
  expect(await readFile(first.args.path, "utf8")).toBe("already committed");
});

it("unread messages and schedules cannot lift upgrade pause, and unrelated conversations run", async () => {
  const r = await run(),
    unknown = await call(r, "edit", "unknown");
  await checkpoint([unknown]);
  await version(9);
  await reopen();
  await k.db.canvas(board, async (tx) => {
    await k.conversations.append(tx, conversationId, key(), "message", {
      from: "workspace",
      text: "New message",
    });
    const frozen = (await k.runs.get(r.id, tx)).frozen_input;
    expect(
      (
        await k.runs.enqueue(tx, {
          canvasId: board,
          subjectId: conversationId,
          kind: "conversation",
          frozen,
        })
      ).id,
    ).toBe(r.id);
  });
  await k.db.pool.query(
    "update schedules set next_due_at=now()-interval '1 second' where agent_id=$1",
    [agentId],
  );
  await k.tools.tickSchedules();
  await k.maintain();
  expect(await k.runs.get(r.id)).toMatchObject({
    state: "waiting",
    reason: "tool_contract_upgrade",
  });
  expect((await k.graph.queries.node(agentId)).agent).toMatchObject({
    enabled: true,
    schedule: { enabled: true },
  });
  expect(
    (
      await k.db.pool.query("select consumed_message_seq from conversations where id=$1", [
        conversationId,
      ])
    ).rows[0].consumed_message_seq,
  ).toBe("0");
  const other = await k.conversations.submit({
    canvasId: board,
    message: "Independent work",
    key: key(),
  });
  let executed: string | undefined;
  const path = join(await k.host.workspace(board), "independent.txt");
  const worker = new Worker(
    k.runs,
    {
      generation: async () => {},
      conversation: async (ctx) => {
        executed = ctx.run.id;
        const tools = await k.tools.create(ctx, ctx.run.frozen_input);
        const output = await invokeTool(ctx, tools.find((t) => t.name === "write")!, "write", {
          path,
          content: "Independent work completed",
        });
        expect(output.result.isError).not.toBe(true);
        await k.runs.finish(ctx.run, "succeeded");
      },
    },
    async () => {},
  );
  worker.start();
  try {
    await expect
      .poll(async () => (await k.runs.get(other.run.id)).state, { timeout: 10000 })
      .toBe("succeeded");
  } finally {
    await worker.close();
  }
  expect(executed).toBe(other.run.id);
  expect(await readFile(path, "utf8")).toBe("Independent work completed");
});

it("unmatched checkpoint calls become reviewable without replay or invented execution evidence", async () => {
  await checkpoint([
    {
      providerId: "missing-write",
      name: "edit",
      args: { path: "/unavailable", oldText: "a", newText: "b" },
    },
    { providerId: "missing-read", name: "read_node", args: { nodeId: "unavailable" } },
  ]);
  await version(9);
  await reopen();
  const view = await k.conversations.read.feed(agentId);
  expect(view.runReason).toBe("tool_contract_upgrade");
  expect(view.unknownTools).toHaveLength(1);
  expect(view.unknownTools[0]).toMatchObject({ name: "edit", canRetry: false });
  expect((await k.db.pool.query("select name,state from tool_calls order by name")).rows).toEqual([
    { name: "edit", state: "unknown" },
    { name: "read_node", state: "failed" },
  ]);
  await k.conversations.resolveUnknown(view.unknownTools[0]!.id, "abandon", "Do not replay");
  expect(await k.runs.claim("worker")).toBeNull();
  const continued = await k.conversations.submit({
    canvasId: board,
    agentId,
    message: "Continue",
    resumeRunId: view.runId,
    key: key(),
  });
  expect(continued.run.frozen_input.model).toBeTruthy();
  expect((await k.runs.claim("worker"))?.id).toBe(continued.run.id);
});

it("claim rechecks unknown outcomes that appear after queuing", async () => {
  const old = await run("failed", "unknown");
  const queued = await k.conversations.submit({
    canvasId: board,
    agentId,
    message: "Next task",
    key: key(),
  });
  await call(old, "bash", "unknown");
  expect(await k.runs.claim("worker")).toBeNull();
  expect(await k.runs.get(queued.run.id)).toMatchObject({ state: "waiting", reason: "unknown" });
});

it("stopping a paused conversation retains unread input and cannot enable manager takeover", async () => {
  const manager = (
    await k.graph.createNode({
      kind: "agent",
      parentId: board,
      title: "Manager",
      position: { x: 400, y: 0, width: 220, height: 300 },
      agent: { role: "admin", persona: "", enabled: false },
      idempotencyKey: key(),
    })
  ).node;
  const member = await k.graph.queries.node(agentId);
  await k.graph.submitMove({
    kind: "move",
    targetParentId: manager.id,
    moves: [{ nodeId: agentId, x: 0, y: 0, expectedLayoutVersion: member.layoutVersion }],
    idempotencyKey: key(),
  });
  const source = await run(),
    unknown = await call(source, "edit", "unknown");
  await k.db.canvas(board, (tx) =>
    k.conversations.append(tx, conversationId, key(), "user", { text: "Keep unread" }),
  );
  await version(9);
  await reopen();
  await k.conversations.resolveUnknown(unknown.id, "abandon", "Do not repeat");
  await k.conversations.stop(agentId);
  expect(
    (
      await k.db.pool.query("select consumed_message_seq from conversations where id=$1", [
        conversationId,
      ])
    ).rows[0].consumed_message_seq,
  ).toBe("0");
  expect((await k.conversations.controlTeams([agentId], "start", key(), "en")).count).toBe(0);
  await k.conversations.submit({
    canvasId: board,
    agentId: manager.id,
    message: "Review member",
    key: key(),
  });
  const current = (await k.runs.claim("manager"))!;
  const ctx = { run: current, store: k.runs, signal: new AbortController().signal, progress() {} };
  const tools = await k.tools.create(ctx, current.frozen_input);
  const output = await invokeTool(ctx, tools.find((t) => t.name === "take_over_run")!, key(), {
    agentId,
    runId: source.id,
  });
  expect(output.result.isError).toBe(true);
  expect(await k.runs.get(source.id)).toMatchObject({
    reason: "tool_contract_upgrade",
    superseded_by_run_id: null,
  });
});

it("final receipts precede current schema validation and definition lookup", async () => {
  const r = await run("running", null);
  const oldArgs = { path: join(directory, "effect.txt"), oldText: "before", newText: "after" };
  await writeFile(oldArgs.path, "do not modify");
  const saved = await call(r, "edit", "succeeded", {
    args: oldArgs,
    result: result({ persisted: "actual-result" }),
  });
  const runRow = await k.runs.get(r.id),
    ctx = {
      run: { ...runRow, attemptId: r.attemptId },
      store: k.runs,
      signal: new AbortController().signal,
      progress() {},
    };
  const tools = await k.tools.create(ctx, runRow.frozen_input);
  const outcome = await invokeTool(
    ctx,
    tools.find((t) => t.name === "edit")!,
    saved.logical,
    oldArgs,
  );
  expect(outcome.result).toEqual({ ...result({ persisted: "actual-result" }), isError: false });
  expect((await invokeTool(ctx, "edit", saved.logical, oldArgs)).result).toEqual(outcome.result);
  await expect(
    invokeTool(ctx, "edit", saved.logical, { ...oldArgs, newText: "different" }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect(await readFile(oldArgs.path, "utf8")).toBe("do not modify");
});

it("migration rollback preserves schema and history, and retry publishes notifications once", async () => {
  const r = await run(),
    unknown = await call(r, "edit", "unknown");
  await checkpoint([unknown]);
  await version(9);
  const before = (
    await k.db.pool.query(
      "select checkpoint,context,message_seq,consumed_message_seq from conversations where id=$1",
      [conversationId],
    )
  ).rows[0];
  await k.db.pool.query(`create function reject_upgrade() returns trigger language plpgsql as $$begin raise exception 'test rollback';end$$;
    create trigger fail_upgrade before update on schema_info for each row execute function reject_upgrade();`);
  await expect(k.db.migrate()).rejects.toThrow("test rollback");
  expect((await k.db.pool.query("select version from schema_info")).rows[0].version).toBe(9);
  expect(
    (
      await k.db.pool.query(
        "select checkpoint,context,message_seq,consumed_message_seq from conversations where id=$1",
        [conversationId],
      )
    ).rows[0],
  ).toEqual(before);
  expect((await stored(unknown.id)).result).toBeNull();
  await k.db.pool.query("drop trigger fail_upgrade on schema_info; drop function reject_upgrade()");
  await k.db.migrate();
  await k.db.migrate();
  expect(
    (await k.conversations.read.history(conversationId)).filter(
      (m) => m.role === "tool_update" && m.content.callId === unknown.id,
    ),
  ).toHaveLength(1);
});

it("startup failures close their database connections and preserve the original error", async () => {
  const connections = async () =>
    Number(
      (await admin.query("select count(*) from pg_stat_activity where datname=$1", [database]))
        .rows[0].count,
    );
  await version(9);
  await k.db.pool.query(`create function reject_upgrade() returns trigger language plpgsql as $$begin raise exception 'migration failed for test';end$$;
    create trigger fail_upgrade before update on schema_info for each row execute function reject_upgrade()`);
  await app.close();
  await expect(buildServer(options)).rejects.toThrow("migration failed for test");
  await expect.poll(connections).toBe(0);
  const maintenance = new pg.Client({ connectionString: options.databaseUrl });
  await maintenance.connect();
  try {
    await maintenance.query(
      "drop trigger fail_upgrade on intrica.schema_info; drop function intrica.reject_upgrade()",
    );
  } finally {
    await maintenance.end();
  }
  const invalidIdentity = join(directory, "invalid-identity");
  await mkdir(join(invalidIdentity, "server.json"), { recursive: true });
  await expect(buildServer({ ...options, dataDir: invalidIdentity })).rejects.toThrow("EISDIR");
  await expect.poll(connections).toBe(0);
  await reopen();
  expect((await app.inject({ method: "GET", url: "/api/v2/ready" })).statusCode).toBe(200);
});
