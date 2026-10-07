import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Node } from "@intrica/contracts";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { Lease } from "../../apps/server/dist/modules/execution/store.js";
import { invokeTool } from "../../apps/server/dist/modules/execution/tool-calls.js";
import { Worker } from "../../apps/server/dist/modules/execution/worker.js";

const key = () => randomUUID();
const database = `intrica_coordination_${key().replaceAll("-", "")}`;
const token = key();
let app: Awaited<ReturnType<typeof buildServer>>, k: Kernel, admin: pg.Client;
let provider: Server, directory: string, board: string;
let inputs: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
const workers: Worker[] = [];
beforeAll(async () => {
  provider = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    inputs.push(input);
    if (JSON.stringify(input.messages).includes("FAIL_AUTH")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "401 unauthorized fixture-private-detail" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: key(), object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.end(
      `${chunk({ role: "assistant", content: "Received." }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const url = new URL(process.env.INTRICA_TEST_ADMIN_URL!);
  admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  await admin.query(`create database ${database}`);
  url.pathname = `/${database}`;
  directory = await mkdtemp(join(tmpdir(), "intrica-coordination-"));
  app = await buildServer({
    databaseUrl: url.href,
    dataDir: directory,
    accessToken: token,
    worker: false,
    model: {
      kind: "pi",
      provider: "openai",
      modelId: "coordination-fixture",
      apiKey: "fixture-only",
      baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
      supportsVision: false,
    },
  });
  await app.ready();
  k = app.kernel;
});
beforeEach(async () => {
  inputs = [];
  board = (await k.graph.createCanvas({ title: "Coordination", idempotencyKey: key() })).node.id;
});
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close();
  await k.db.pool.query("update conversations set consumed_message_seq=message_seq");
  await k.db.pool.query(
    "update runs set state='cancelled',cancel_requested_at=now() where state in('queued','running','waiting')",
  );
});
afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await admin.query(`drop database ${database} with(force)`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
});
const agent = async (parentId = board, role: "admin" | "write" = "write") =>
  (
    await k.graph.createNode({
      kind: "agent",
      parentId,
      title: key(),
      agent: { persona: key(), role, enabled: false },
      position: { x: 0, y: 0, width: 220, height: 300 },
      idempotencyKey: key(),
    })
  ).node;
const submit = (member: Node, message = "Work on the assigned task.") =>
  k.conversations.submit({
    canvasId: board,
    agentId: member.id,
    message,
    key: key(),
    language: "en",
  });
async function start(member: Node) {
  const submitted = await submit(member);
  const run = (await k.runs.claim("coordination-test"))!;
  expect(run.id).toBe(submitted.run.id);
  return run;
}
const context = (run: Lease) => ({
  run,
  store: k.runs,
  signal: new AbortController().signal,
  progress() {},
});
async function call(run: Lease, name: string, args: object, logical = key()) {
  const ctx = context(run);
  const tools = await k.tools.create(ctx, run.frozen_input);
  const outcome = await invokeTool(ctx, tools.find((tool) => tool.name === name)!, logical, args);
  const text = (outcome.result.content[0] as { text: string }).text;
  let value: any = text;
  try {
    value = JSON.parse(text);
  } catch {}
  return { ...outcome, value };
}
const history = async (member: Node) => {
  const conversation = await k.conversations.read.forAgent(member.id);
  return (
    await k.db.pool.query("select * from messages where conversation_id=$1 order by seq", [
      conversation.id,
    ])
  ).rows;
};
const runs = async (member: Node) =>
  (
    await k.db.pool.query(
      "select r.* from runs r join conversations c on c.id=r.subject_id where c.agent_id=$1 order by r.created_at,r.id",
      [member.id],
    )
  ).rows;

it("delivers a real provider failure through the worker to the manager exactly once", async () => {
  const manager = await agent(board, "admin"),
    member = await agent(manager.id);
  const submitted = await submit(member, "FAIL_AUTH");
  const worker = new Worker(k.runs, k.worker.handlers, k.worker.schedule);
  workers.push(worker);
  worker.start();
  await expect.poll(async () => (await k.runs.get(submitted.run.id)).state).toBe("failed");
  await expect.poll(async () => (await runs(manager)).at(-1)?.state).toBe("succeeded");
  const source = await k.runs.get(submitted.run.id);
  expect(source.reason).toContain("认证失败");
  expect((await history(member)).filter((m) => m.role === "run_status")).toHaveLength(1);
  const notices = (await history(manager)).filter((m) => m.role === "team_notice");
  expect(notices).toHaveLength(1);
  expect(notices[0].content).toMatchObject({
    runId: source.id,
    state: "failed",
    subjectId: member.id,
  });
  expect(JSON.stringify(notices)).not.toContain("fixture-private-detail");
  const received = inputs.find((input) => JSON.stringify(input.messages).includes(source.id));
  expect(JSON.stringify(received)).toContain("not user authorization");
  expect(JSON.stringify(received)).not.toContain("fixture-private-detail");
  await k.access.maintain();
  expect(await runs(manager)).toHaveLength(1);
});

it("measures manager activation with and without a durable inbox notice", async () => {
  const activations: number[] = [];
  for (const inboxNotice of [false, true]) {
    const manager = await agent(board, "admin"),
      member = await agent(manager.id);
    const source = await start(member);
    await k.runs.fail(source, new Error("timeout"));
    if (!inboxNotice) {
      const c = await k.conversations.read.forAgent(manager.id);
      await k.db.pool.query(
        "delete from messages where conversation_id=$1 and role='team_notice'",
        [c.id],
      );
    }
    await k.access.maintain();
    activations.push((await runs(manager)).length);
    expect((await history(member)).filter((m) => m.role === "run_status")).toHaveLength(1);
  }
  expect(activations).toEqual([0, 1]);
});

it("wakes a waiting manager for unknown tool outcomes and rejects takeover", async () => {
  const manager = await agent(board, "admin"),
    member = await agent(manager.id);
  const managerRun = await start(manager);
  await k.runs.finish(managerRun, "waiting", undefined, "message");
  const source = await start(member);
  await k.db.pool.query(
    "insert into tool_calls(id,run_id,attempt_id,logical_call_id,name,args,args_hash,effect_class,state) values($1,$2,$3,$1,'edit','{}','fixture','external','dispatching')",
    [key(), source.id, source.attemptId],
  );
  await k.runs.fail(source, new Error("worker connection lost"));
  expect(await k.runs.get(source.id)).toMatchObject({ state: "waiting", reason: "unknown" });
  expect((await k.runs.get(managerRun.id)).state).toBe("queued");
  const current = (await k.runs.claim("manager"))!;
  const rejected = await call(current, "take_over_run", { agentId: member.id, runId: source.id });
  expect(rejected.result.isError).toBe(true);
  expect((await k.runs.get(source.id)).superseded_by_run_id).toBeNull();
  expect((await history(manager)).filter((m) => m.role === "team_notice")).toHaveLength(1);
});

it("ignores stale notices and enforces automatic activation budgets", async () => {
  const manager = await agent(board, "admin"),
    member = await agent(manager.id);
  const failed = await start(member);
  await k.runs.fail(failed, new Error("timeout"));
  await submit(member, "New independent task");
  await k.access.maintain();
  expect(await runs(manager)).toHaveLength(0);
  const next = (await k.runs.claim("next"))!;
  await k.db.pool.query("update runs set activation_count=$2 where id=$1", [
    next.cause_id,
    k.runs.limits.collaborationActivations,
  ]);
  await k.runs.fail(next, new Error("timeout"));
  await k.access.maintain();
  expect(await runs(manager)).toHaveLength(0);
  const notices = (await history(manager)).filter((m) => m.role === "team_notice");
  expect(notices.at(-1).content.activationBlocked).toBe(true);
  expect((await k.activity.inspect(board, [manager.id]))[0]).toMatchObject({
    pendingMessages: 0,
    blockedMessages: 1,
  });
});

it("paginates public exchanges before the limit and returns input consumption receipts", async () => {
  const manager = await agent(board, "admin"),
    member = await agent(manager.id);
  const source = await start(member);
  await k.runs.finish(source, "succeeded");
  const c = await k.conversations.read.forAgent(member.id);
  await k.db.pool.query(
    `insert into messages(conversation_id,seq,client_message_id,role,content,run_id)
     select $1,i,'history-'||i,case when i%5=0 and i<=475 then 'message' else 'assistant' end,
       case when i%5=0 and i<=475 then jsonb_build_object('from',$2::text,'text','public-'||i)
       else jsonb_build_object('text','private-'||i) end,$3
     from generate_series(3,675) i`,
    [c.id, manager.id, source.id],
  );
  await k.db.pool.query(
    "update conversations set message_seq=675,consumed_message_seq=400 where id=$1",
    [c.id],
  );
  await k.db.pool.query(
    "update messages set consumed_run_id=$2 where conversation_id=$1 and seq<=400",
    [c.id, source.id],
  );
  const managerRun = await start(manager);
  const first = (await call(managerRun, "read_conversation", { agentId: member.id })).value;
  expect(first.events).toHaveLength(80);
  expect(JSON.stringify(first)).not.toContain("private-");
  expect(first.events.at(-1).receipt.status).toBe("queued");
  expect(first.events[0].receipt.status).toBe("consumed");
  const second = (
    await call(managerRun, "read_conversation", { agentId: member.id, before: first.nextBefore })
  ).value;
  expect(second.events).toHaveLength(16);
  expect(second.nextBefore).toBeNull();
  const recent = await k.conversations.read.history(c.id);
  expect(recent.filter((m) => m.role === "message")).toHaveLength(0);
  const stranger = await agent();
  expect(
    (await call(managerRun, "read_conversation", { agentId: stranger.id })).result.isError,
  ).toBe(true);
});

it("binds pending inbox input when the owner starts a run before maintenance", async () => {
  const manager = await agent(board, "admin"),
    member = await agent(manager.id);
  const source = await start(member);
  await k.runs.fail(source, new Error("timeout"));
  const managerRun = await start(manager);
  const notices = (await history(manager)).filter((m) => m.role === "team_notice");
  expect(notices[0].run_id).toBe(managerRun.id);
  await k.worker.handlers.conversation(context(managerRun));
  expect(JSON.stringify(inputs.at(-1))).toContain(source.id);
  expect(JSON.stringify(inputs.at(-1))).toContain("Work on the assigned task.");
});

it("distinguishes closed inbox entries from input persisted in model context", async () => {
  const manager = await agent(board, "admin"),
    member = await agent(manager.id);
  const managerRun = await start(manager);
  await call(managerRun, "send_message", {
    target: { kind: "agent", agentId: member.id },
    message: "First assignment",
  });
  const before = (await call(managerRun, "read_conversation", { agentId: member.id })).value;
  expect(before.events.at(-1).receipt.status).toBe("queued");
  await k.conversations.stop(member.id);
  const stopped = (await call(managerRun, "read_conversation", { agentId: member.id })).value;
  expect(stopped.events.at(-1).receipt.status).toBe("closed");
  await call(managerRun, "send_message", {
    target: { kind: "agent", agentId: member.id },
    message: "Second assignment",
  });
  await k.access.maintain();
  const memberRun = (await k.runs.claim("member"))!;
  await k.worker.handlers.conversation(context(memberRun));
  const after = (await call(managerRun, "read_conversation", { agentId: member.id })).value;
  const second = after.events.find((e: any) => e.data.text === "Second assignment");
  expect(second.receipt).toMatchObject({ status: "consumed", runId: memberRun.id });
  expect(after.events.find((e: any) => e.data.text === "First assignment").receipt.status).toBe(
    "closed",
  );
  expect(JSON.stringify(inputs.at(-1))).toContain("Second assignment");
  expect(JSON.stringify(inputs.at(-1))).not.toContain("First assignment");
});

it("writes one status for a stopped turn-limited run and notifies only its current manager", async () => {
  const manager = await agent(board, "admin"),
    member = await agent(manager.id);
  const source = await start(member);
  await k.runs.finish(source, "waiting", undefined, "turn_limit");
  expect(
    (await history(member)).filter((m) => ["status", "run_status"].includes(m.role)),
  ).toHaveLength(1);
  const index = await k.conversations.read.navigation.index(source.subject_id, 0);
  expect(index.items).toHaveLength(2);
  await k.graph.submitMove({
    kind: "move",
    targetParentId: board,
    moves: [{ nodeId: member.id, x: 0, y: 0, expectedLayoutVersion: member.layoutVersion }],
    idempotencyKey: key(),
  });
  await k.access.maintain();
  expect(await runs(manager)).toHaveLength(0);
});

it("transfers stopped work atomically, blocks stale continuation and delivers readable results", async () => {
  const manager = await agent(board, "admin"),
    member = await agent(manager.id);
  const source = await start(member);
  await k.runs.fail(source, new Error("timeout"));
  const managerRun = await start(manager);
  const args = { agentId: member.id, runId: source.id },
    logical = key();
  const accepted = await call(managerRun, "take_over_run", args, logical);
  expect(accepted.result.isError).not.toBe(true);
  expect((await call(managerRun, "take_over_run", args, logical)).value).toEqual(accepted.value);
  expect((await history(member)).filter((m) => m.role === "context_notice")).toHaveLength(1);
  const response = await app.inject({
    method: "POST",
    url: `/api/v2/canvas-agents/${member.id}/run`,
    headers: { authorization: `Bearer ${token}` },
    payload: { message: "Continue", resumeRunId: source.id },
  });
  expect(response.statusCode).toBe(422);
  expect(response.json().error.code).toBe("INVALID_STATE");
  expect((await runs(member)).at(-1).id).toBe(source.id);
  const batch = await k.conversations.controlTeams([member.id], "start", key(), "en");
  expect(batch.count).toBe(0);
  const artifact = await call(managerRun, "create_artifact", {
    kind: "text",
    title: "Verified result",
    text: "Authoritative result",
  });
  const report = await call(managerRun, "report_result", {
    message: "Completed with verified result",
    resourceIds: [artifact.value.id],
  });
  expect(report.result.isError).not.toBe(true);
  expect(report.value.informedExecutors).toEqual([member.id]);
  const notice = (await history(member)).find((m) => m.content.phase === "reported");
  expect(notice.content.resourceIds).toEqual([artifact.value.id]);
  expect(
    (await k.access.describe(member.id)).resources.some(
      (r) => r.nodeId === artifact.value.id && r.mode === "read",
    ),
  ).toBe(true);
  await k.runs.finish(managerRun, "succeeded");
  await k.access.maintain();
  expect(await runs(member)).toHaveLength(1);
  await k.conversations.stop(member.id);
  const next = await submit(
    member,
    "Review the delivered result. Do not repeat the previous task.",
  );
  const claimed = (await k.runs.claim("new-input"))!;
  expect(claimed.id).toBe(next.run.id);
  await k.worker.handlers.conversation(context(claimed));
  expect(JSON.stringify(inputs.at(-1))).toContain("Completed with verified result");
  expect(JSON.stringify(inputs.at(-1))).toContain("Do not resume its work");
});

it("refuses live, unrelated and outdated runs and preserves handoffs on explicit manager continuation", async () => {
  const manager = await agent(board, "admin"),
    member = await agent(manager.id),
    outsider = await agent();
  const source = await start(member);
  const managerRun = await start(manager);
  expect(
    (await call(managerRun, "take_over_run", { agentId: member.id, runId: source.id })).result
      .isError,
  ).toBe(true);
  await k.runs.fail(source, new Error("timeout"));
  expect(
    (await call(managerRun, "take_over_run", { agentId: outsider.id, runId: source.id })).result
      .isError,
  ).toBe(true);
  expect(
    (await call(managerRun, "take_over_run", { agentId: member.id, runId: "stale" })).result
      .isError,
  ).toBe(true);
  expect(
    (await call(managerRun, "take_over_run", { agentId: member.id, runId: source.id })).result
      .isError,
  ).not.toBe(true);
  await k.runs.fail(managerRun, new Error("timeout"));
  const resumed = await k.conversations.submit({
    canvasId: board,
    agentId: manager.id,
    key: key(),
    message: "Continue",
    resumeRunId: managerRun.id,
  });
  expect((await k.runs.get(source.id)).superseded_by_run_id).toBe(resumed.run.id);
});
