import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Node } from "@intrica/contracts";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Lease } from "../../apps/server/dist/modules/execution/store.js";
import { invokeTool } from "../../apps/server/dist/modules/execution/tool-calls.js";
import { Worker } from "../../apps/server/dist/modules/execution/worker.js";
import { expediteInput } from "../../apps/server/dist/modules/work/input-receipts.js";
import { wireOutput } from "../fixtures/addressed-output.mjs";

const key = () => randomUUID();
const database = `intrica_coordination_${key().replaceAll("-", "")}`;
const token = key();
let app: Awaited<ReturnType<typeof buildServer>>, k: Kernel, admin: pg.Client;
let provider: Server, directory: string, board: string;
let inputs: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
const workers: Worker[] = [];
let holdNext: ((response: ServerResponse) => Promise<void>) | undefined;
beforeAll(async () => {
  provider = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    inputs.push(input);
    const held = holdNext;
    holdNext = undefined;
    if (held) await held(res);
    if (res.destroyed) return;
    if (JSON.stringify(input.messages).includes("FAIL_AUTH")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "401 unauthorized fixture-private-detail" } }));
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "x-request-id": "provider-request-fixture",
    });
    const chunk = (delta: object, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: "provider-response-fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132, prompt_tokens_details: { cached_tokens: 20 } } })}\n\n`;
    res.end(
      `${chunk({ role: "assistant", content: wireOutput(input.messages, "Received.") }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
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
    "update messages set content=content||'{\"closed\":true}'::jsonb where consumed_run_id is null",
  );
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

async function until(check: () => Promise<boolean>, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for durable state");
    await delay(20);
  }
}
function holdResponse() {
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => {
    started = r;
  });
  const held = new Promise<void>((r) => {
    release = r;
  });
  let cancelled = false;
  holdNext = async (response) => {
    response.once("close", () => {
      cancelled = true;
    });
    started();
    await held;
  };
  return { entered, release, cancelled: () => cancelled };
}
it("ordinary input stays unread during inference; explicit expedite consumes distinct IDs in order", async () => {
  const member = await agent(),
    run = await start(member),
    held = holdResponse();
  const execution = k.worker.handlers.conversation(context(run));
  try {
    await held.entered;
    const first = await k.conversations.submit({
      canvasId: board,
      agentId: member.id,
      message: "Same text",
      association: { kind: "append", requestId: run.frozen_input.workItemId },
      key: key(),
    });
    const second = await k.conversations.submit({
      canvasId: board,
      agentId: member.id,
      message: "Same text",
      association: { kind: "append", requestId: run.frozen_input.workItemId },
      key: key(),
    });
    await delay(150);
    const view = await k.conversations.read.view(run.subject_id);
    expect(
      view.messages.filter((m) => m.role === "user").map((m) => m.content.inputReceipt.state),
    ).toEqual(["read", "unread", "unread"]);
    expect(held.cancelled()).toBe(false);
    await Promise.all([
      expediteInput(k.db, run.subject_id, second.messageId),
      expediteInput(k.db, run.subject_id, second.messageId),
    ]);
    await execution;
    expect(held.cancelled()).toBe(true);
    expect(inputs).toHaveLength(2);
    const messages = (await history(member)).filter((m) => m.role === "user");
    expect(messages.slice(1).map((m) => m.client_message_id)).toEqual([
      first.messageId,
      second.messageId,
    ]);
    expect(messages.every((m) => m.consumed_run_id === run.id)).toBe(true);
    expect(JSON.stringify(inputs[1]!.messages).match(/Same text/g)).toHaveLength(2);
    expect(await expediteInput(k.db, run.subject_id, second.messageId)).toMatchObject({
      state: "read",
    });
  } finally {
    held.release();
    await execution;
  }
});
it("approved independent tools resume within two seconds without interrupting inference or consuming normal input", async () => {
  const member = await agent(),
    run = await start(member);
  const path = join(directory, "outside-workspace.txt");
  await writeFile(path, "read-once");
  const logical = key(),
    pending = await call(run, "read", { target: { kind: "path", path } }, logical);
  expect(pending.waiting).toBe("approval");
  await k.db.pool.query(
    "update tool_calls set is_async=true,delivered_at=now() where id=(select origin_call_id from approvals where id=$1)",
    [pending.value.requestId],
  );
  const held = holdResponse(),
    execution = k.worker.handlers.conversation(context(run));
  try {
    await held.entered;
    const queued = await k.conversations.submit({
      canvasId: board,
      agentId: member.id,
      message: "ordinary input",
      key: key(),
    });
    const started = Date.now();
    await k.access.decide(pending.value.requestId, 1, "approve", "Allow this read");
    await until(
      async () =>
        (
          await k.db.pool.query(
            "select state from tool_calls where run_id=$1 and logical_call_id=$2",
            [run.id, logical],
          )
        ).rows[0].state === "succeeded",
      2000,
    );
    expect(Date.now() - started).toBeLessThanOrEqual(2000);
    expect(held.cancelled()).toBe(false);
    expect(
      (await history(member)).find((m) => m.client_message_id === queued.messageId).consumed_run_id,
    ).toBeNull();
    expect(await readFile(path, "utf8")).toBe("read-once");
    expect(
      (
        await k.db.pool.query(
          "select count(*)::int as n from tool_calls where run_id=$1 and logical_call_id=$2",
          [run.id, logical],
        )
      ).rows[0].n,
    ).toBe(1);
  } finally {
    held.release();
    await execution;
  }
});
it("expedite cannot restart a stopped run or consume a reset input", async () => {
  const member = await agent(),
    run = await start(member);
  const queued = await k.conversations.submit({
    canvasId: board,
    agentId: member.id,
    message: "pending",
    key: key(),
  });
  await k.conversations.stop(member.id);
  await k.runs.fail(run, new Error("stopped"));
  await expect(expediteInput(k.db, run.subject_id, queued.messageId)).rejects.toMatchObject({
    code: "INVALID_STATE",
  });
  await k.conversations.reset(member.id);
  expect(
    (await k.conversations.read.view(run.subject_id)).messages.find(
      (m) => m.content.text === "pending",
    ).content.inputReceipt.state,
  ).toBe("closed");
});

it("a rolled-back checkpoint never publishes a read receipt", async () => {
  const member = await agent(),
    run = await start(member);
  const canvas = k.db.canvas.bind(k.db);
  const failing = vi.spyOn(k.db, "canvas").mockImplementation(async (id, action, ...args) =>
    canvas(
      id,
      async (tx) => {
        const result = await action(tx);
        if (
          (
            await tx.query(
              "select 1 from messages where conversation_id=$1 and consumed_run_id=$2",
              [run.subject_id, run.id],
            )
          ).rowCount
        )
          throw new Error("fixture rollback");
        return result;
      },
      ...args,
    ),
  );
  try {
    await expect(
      k.conversations.execute(context(run), (ctx, input) => k.tools.create(ctx, input)),
    ).rejects.toThrow("fixture rollback");
  } finally {
    failing.mockRestore();
  }
  const view = await k.conversations.read.view(run.subject_id);
  expect(view.messages[0].content.inputReceipt.state).toBe("unread");
  expect(
    (await k.db.pool.query("select checkpoint from conversations where id=$1", [run.subject_id]))
      .rows[0].checkpoint,
  ).toEqual([]);
  expect((await k.events.read("run", run.id, "0")).some((e) => e.type === "input.receipt")).toBe(
    false,
  );
});

it("connects request, input, run, attempt and provider IDs in a prompt-free trace", async () => {
  const member = await agent();
  const response = await app.inject({
    method: "POST",
    url: `/api/v2/canvas-agents/${member.id}/run`,
    headers: { authorization: `Bearer ${token}` },
    payload: { message: "private-trace-prompt", idempotencyKey: key() },
  });
  expect(response.statusCode).toBe(202);
  const run = (await k.runs.claim("trace"))!;
  await k.worker.handlers.conversation(context(run));
  const trace = (
    await app.inject({
      url: `/api/v2/conversations/${run.subject_id}/trace`,
      headers: { authorization: `Bearer ${token}` },
    })
  ).json();
  expect(trace.inputs[0]).toMatchObject({ id: response.json().messageId, consumed_run_id: run.id });
  expect(trace.runs[0].request_id).toBe(response.headers["x-request-id"]);
  expect(trace.models[0]).toMatchObject({
    run_id: run.id,
    attempt_id: run.attemptId,
    request_id: response.headers["x-request-id"],
    provider_request_id: "provider-request-fixture",
    response_id: "provider-response-fixture",
    input_tokens: "120",
    output_tokens: "12",
    cache_read_tokens: "20",
  });
  expect(Number(trace.models[0].first_response_ms)).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(trace)).not.toContain("private-trace-prompt");
  expect(JSON.stringify(trace)).not.toContain("fixture-only");
  expect(
    (await app.inject({ url: `/api/v2/conversations/${run.subject_id}/trace` })).statusCode,
  ).toBe(401);
});

it("conversation views select the current run after cancellation or failure", async () => {
  for (const state of ["cancelled", "failed"] as const) {
    const member = await agent();
    const first = await start(member);
    if (state === "cancelled") await k.runs.cancel(first.id);
    await k.runs.fail(first, new Error("timeout"));
    expect(await k.runs.get(first.id)).toMatchObject({ state, reason: expect.any(String) });

    const next = await submit(member, "Continue with a new task.");
    expect(next.run.id).not.toBe(first.id);
    const assertCurrent = async (state: string, reason: string | null = null) => {
      const headers = { authorization: `Bearer ${token}` };
      const view = await app.inject({
        method: "GET",
        url: `/api/v2/conversations/${first.subject_id}`,
        headers,
      });
      expect(view.statusCode).toBe(200);
      expect(view.json().run).toMatchObject({ id: next.run.id, state, reason });
      const feed = await app.inject({
        method: "GET",
        url: `/api/v2/canvas-agents/${member.id}`,
        headers,
      });
      expect(feed.statusCode).toBe(200);
      expect(feed.json()).toMatchObject({
        runId: next.run.id,
        runState: state,
        runReason: reason,
        running: state === "queued" || state === "running",
        interrupted: false,
      });
    };
    await assertCurrent("queued");
    const lease = (await k.runs.claim("coordination-test"))!;
    expect(lease.id).toBe(next.run.id);
    await assertCurrent("running");
    await k.runs.finish(lease, "waiting", undefined, "message");
    await assertCurrent("waiting", "message");
    expect((await submit(member, "Continue now.")).run.id).toBe(lease.id);
    await assertCurrent("queued");
    const resumed = (await k.runs.claim("coordination-test"))!;
    expect(resumed.id).toBe(next.run.id);
    await k.runs.finish(resumed, "succeeded");
    await assertCurrent("succeeded");
  }
});

it("conversation input waits for cancellation to settle before admission", async () => {
  for (const agentId of [undefined, (await agent()).id]) {
    const first = await k.conversations.submit({
      canvasId: board,
      ...(agentId ? { agentId } : {}),
      message: "Original task",
      key: key(),
    });
    const lease = (await k.runs.claim("coordination-test"))!;
    expect(lease.id).toBe(first.run.id);
    const headers = { authorization: `Bearer ${token}` };
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/v2/runs/${lease.id}/cancel`,
      headers,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(await k.runs.get(lease.id)).toMatchObject({
      state: "running",
      cancel_requested_at: expect.any(Date),
    });
    const inputKey = key();
    const post = () =>
      app.inject({
        method: "POST",
        url: agentId ? `/api/v2/canvas-agents/${agentId}/run` : "/api/v2/agent/steer",
        headers,
        payload: {
          ...(!agentId ? { sessionId: first.conversationId } : {}),
          message: "New task after stopping",
          idempotencyKey: inputKey,
        },
      });
    const rejected = await post();
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error.code).toBe("INVALID_STATE");
    const admitted = () =>
      k.db.pool.query(
        "select run_id from messages where conversation_id=$1 and client_message_id=$2",
        [first.conversationId, inputKey],
      );
    expect((await admitted()).rows).toHaveLength(0);
    await k.runs.fail(lease, new Error("cancelled"));
    const accepted = await post();
    expect(accepted.statusCode).toBe(agentId ? 202 : 200);
    expect((await post()).json()).toEqual(accepted.json());
    const next = (await k.runs.claim("coordination-test"))!;
    expect(next.id).not.toBe(lease.id);
    expect((await admitted()).rows).toEqual([{ run_id: next.id }]);
    await k.runs.finish(next, "succeeded");
  }
});

it("queued and waiting cancellation retains a terminal reason", async () => {
  for (const state of ["queued", "waiting"]) {
    for (const team of [false, true]) {
      const member = await agent();
      const submitted = await submit(member);
      if (state === "waiting") {
        const lease = (await k.runs.claim("coordination-test"))!;
        expect(lease.id).toBe(submitted.run.id);
        await k.runs.finish(lease, "waiting", undefined, "message");
      }
      const headers = { authorization: `Bearer ${token}` };
      const response = await app.inject({
        method: "POST",
        url: team
          ? `/api/v2/canvas-agents/${member.id}/stop`
          : `/api/v2/runs/${submitted.run.id}/cancel`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      const view = await app.inject({
        method: "GET",
        url: `/api/v2/conversations/${submitted.conversationId}`,
        headers,
      });
      expect(view.statusCode).toBe(200);
      expect(view.json().run).toMatchObject({
        id: submitted.run.id,
        state: "cancelled",
        reason: "已停止",
      });
    }
  }
});

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
  await k.maintain();
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
    await k.maintain();
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
  await k.maintain();
  expect(await runs(manager)).toHaveLength(0);
  const next = (await k.runs.claim("next"))!;
  await k.db.pool.query("update runs set activation_count=$2 where id=$1", [
    next.cause_id,
    k.runs.limits.collaborationActivations,
  ]);
  await k.runs.fail(next, new Error("timeout"));
  await k.maintain();
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
    kind: "update",
    target: { kind: "agent", agentId: member.id },
    message: "First assignment",
  });
  const before = (await call(managerRun, "read_conversation", { agentId: member.id })).value;
  expect(before.events.at(-1).receipt.status).toBe("queued");
  await k.conversations.stop(member.id);
  const stopped = (await call(managerRun, "read_conversation", { agentId: member.id })).value;
  expect(stopped.events.at(-1).receipt.status).toBe("closed");
  await call(managerRun, "send_message", {
    kind: "update",
    target: { kind: "agent", agentId: member.id },
    message: "Second assignment",
  });
  await k.maintain();
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
  await k.maintain();
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
  const report = await call(managerRun, "send_message", {
    kind: "result",
    target: { kind: "request", id: accepted.value.requestIds[0] },
    message: "Completed with verified result",
    handoff: { sourceRunIds: [source.id], resourceIds: [artifact.value.id] },
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
  await k.maintain();
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
