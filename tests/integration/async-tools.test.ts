import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { runProcess } from "../../apps/server/dist/adapters/host/sandbox.js";
import { Agent } from "../../apps/server/dist/adapters/model/agent.js";
import { BackgroundTools } from "../../apps/server/dist/modules/execution/background-tools.js";
import { DEFAULT_LIMITS } from "../../apps/server/dist/modules/execution/limits.js";
import {
  type ExecutionTool,
  invokeTool,
  result,
} from "../../apps/server/dist/modules/execution/tool-calls.js";
import { addressedOutput } from "../fixtures/addressed-output.mjs";

const key = () => randomUUID();
const adminUrl = process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres";
const dbName = `intrica_async_${key().replaceAll("-", "")}`;
let app: Awaited<ReturnType<typeof buildServer>>, k: Kernel, dir: string, admin: pg.Client;
const controllers: AbortController[] = [];
const measurements: Record<string, unknown> = {};
const limits = { ...DEFAULT_LIMITS, toolAsyncAfterMs: 50, toolNoticeMs: 80, toolTimeoutMs: 60000 };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function until(check: () => Promise<boolean> | boolean, ms = 5000) {
  const end = performance.now() + ms;
  while (!(await check())) {
    if (performance.now() > end) throw new Error("condition not reached");
    await delay(10);
  }
}
const slow = (
  execute: ExecutionTool["execute"],
  extra: Partial<ExecutionTool> = {},
): ExecutionTool => ({
  name: "slow",
  label: "slow",
  description: "fixture",
  parameters: Type.Object({ value: Type.String() }),
  effect: "read",
  execute,
  ...extra,
});
async function prepared(count = 1) {
  const canvasId = (await k.graph.createCanvas({ title: "async boundary", idempotencyKey: key() }))
    .node.id;
  const submitted = await k.conversations.submit({ canvasId, message: "执行并汇总", key: key() });
  const run = (await k.runs.claim("async-test"))!;
  expect(run.id).toBe(submitted.run.id);
  const template = {
    role: "assistant",
    content: Array.from({ length: count }, (_, i) => ({
      type: "toolCall",
      id: `call-${i}`,
      name: "slow",
      arguments: { value: String(i) },
    })),
    api: "openai-completions",
    provider: "test",
    model: "test",
    stopReason: "toolUse",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      totalTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
    },
  };
  await k.db.pool.query(
    "update conversations set checkpoint=$2,consumed_message_seq=message_seq,context=$3 where id=$1",
    [
      submitted.conversationId,
      JSON.stringify([template]),
      JSON.stringify({ pendingTurnId: "turn" }),
    ],
  );
  const abort = new AbortController();
  controllers.push(abort);
  return {
    canvasId,
    submitted,
    template,
    ctx: { run, store: k.runs, signal: abort.signal, progress() {} },
  };
}
beforeAll(async () => {
  await mkdir(resolve("test-results"), { recursive: true });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  dir = await mkdtemp(join(tmpdir(), "intrica-async-"));
  app = await buildServer({
    databaseUrl: url.href,
    dataDir: dir,
    accessToken: key(),
    worker: false,
    model: { kind: "mock", supportsVision: true, streamDelayMs: 0 },
    execution: { ...limits },
  });
  await app.ready();
  k = app.kernel;
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const c of controllers.splice(0)) c.abort();
  Object.assign(k.runs.limits, limits);
});
afterAll(async () => {
  await app?.close();
  await admin.query(`drop database if exists ${dbName} with(force)`);
  await admin.end();
  if (dir) await rm(dir, { recursive: true, force: true });
  await writeFile(
    resolve("test-results/async-tools-update.json"),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        platform: process.platform,
        node: process.version,
        scope: "isolated PostgreSQL, production execution code, controlled model",
        measurements,
      },
      null,
      2,
    ),
  );
});

it("atomically publishes an image result before inference fails, then consumes it in a new run", async () => {
  const { ctx, submitted, canvasId } = await prepared();
  const gate = deferred();
  let calls = 0;
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  const tool = slow(async () => {
    calls++;
    await gate.promise;
    return {
      content: [
        { type: "text", text: "FINAL-DURABLE" },
        { type: "image", mimeType: "image/png", data: png },
      ],
      details: {},
    };
  });
  const spy = vi.spyOn(Agent.prototype, "turn").mockImplementationOnce(async () => {
    gate.resolve();
    await until(async () =>
      Boolean(
        (
          await k.db.pool.query(
            "select 1 from messages where conversation_id=$1 and role='tool_update' and content->>'status'='succeeded'",
            [submitted.conversationId],
          )
        ).rowCount,
      ),
    );
    throw new Error("inference failed after tool commit");
  });
  await expect(k.conversations.execute(ctx, async () => [tool])).rejects.toThrow(
    "inference failed after tool commit",
  );
  spy.mockRestore();
  await k.runs.fail(ctx.run, new Error("inference failed"));
  const persisted = (
    await k.db.pool.query("select * from tool_calls where run_id=$1", [ctx.run.id])
  ).rows[0];
  expect(persisted.state).toBe("succeeded");
  expect(persisted.delivered_at).not.toBeNull();
  const notice = (await k.conversations.read.history(submitted.conversationId)).find(
    (m) => m.role === "tool_update",
  )!;
  expect(notice.content.callId).toBe(persisted.id);
  expect(JSON.stringify(notice.content)).not.toContain(png);
  const next = await k.conversations.submit({
    canvasId,
    conversationId: submitted.conversationId,
    message: "继续汇总",
    key: key(),
  });
  const run = (await k.runs.claim("continue"))!;
  expect(run.id).toBe(next.run.id);
  expect(run.id).not.toBe(ctx.run.id);
  await k.conversations.execute({ ...ctx, run }, async () => []);
  const checkpoint = (
    await k.db.pool.query("select checkpoint from conversations where id=$1", [
      submitted.conversationId,
    ])
  ).rows[0].checkpoint;
  expect(JSON.stringify(checkpoint)).toContain("FINAL-DURABLE");
  expect(
    checkpoint
      .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
      .some((p: any) => p.type === "image" && p.data === "" && p.intricaMedia?.id),
  ).toBe(true);
  const registry = await k.tools.create(
    { ...ctx, run },
    {
      conversationId: submitted.conversationId,
      agentId: null,
      model: run.frozen_input.model,
      selection: [],
    },
  );
  const retrieved = await registry
    .find((t) => t.name === "get_tool_result")!
    .execute(key(), { callId: persisted.id }, ctx.signal);
  expect(JSON.stringify(retrieved)).not.toContain(png);
  const hydrated = await k.runs.media!.hydrate(retrieved, submitted.conversationId);
  expect(hydrated.content.some((p) => p.type === "image" && p.data === png)).toBe(true);
  expect(calls).toBe(1);
  measurements.atomicDelivery = {
    executions: calls,
    durableFinalMessages: 1,
    imagePreserved: true,
    crossRunScanner: false,
  };
});

it("rolls back both outcome and notification if publication fails", async () => {
  const { ctx } = await prepared();
  const gate = deferred();
  const bg = new BackgroundTools(
    ctx,
    [],
    async () => {},
    async () => {
      throw new Error("message storage failure");
    },
  );
  try {
    await bg.invoke(
      slow(
        async () => {
          await gate.promise;
          return result("effect");
        },
        { effect: "external" },
      ),
      "rollback",
      { value: "x" },
    );
    gate.resolve();
    await expect
      .poll(async () => {
        try {
          await bg.deliver();
          return "pending";
        } catch (e) {
          return (e as Error).message;
        }
      })
      .toBe("message storage failure");
    const row = (
      await k.db.pool.query("select state,delivered_at from tool_calls where run_id=$1", [
        ctx.run.id,
      ])
    ).rows[0];
    expect(row).toEqual({ state: "dispatching", delivered_at: null });
  } finally {
    gate.resolve();
    await bg.close();
  }
  await k.runs.fail(ctx.run, new Error("storage failure"));
  const row = (await k.db.pool.query("select id from tool_calls where run_id=$1", [ctx.run.id]))
    .rows[0];
  await k.conversations.resolveUnknown(row.id, "abandon", "test cleanup");
  await k.runs.cancel(ctx.run.id);
});

it("does not regress a completed call at the async boundary", async () => {
  const { ctx } = await prepared();
  const gate = deferred();
  const original = k.db.canvas.bind(k.db);
  let transactions = 0;
  const spy = vi.spyOn(k.db, "canvas").mockImplementation(async (...args) => {
    if (++transactions === 2) {
      gate.resolve();
      await until(async () =>
        Boolean(
          (
            await k.db.pool.query(
              "select 1 from tool_calls where run_id=$1 and state='succeeded'",
              [ctx.run.id],
            )
          ).rowCount,
        ),
      );
    }
    return original(...args);
  });
  const detach = vi.fn();
  try {
    const execution = await invokeTool(
      ctx,
      slow(async () => {
        await gate.promise;
        return result("completed-before-detach");
      }),
      "boundary",
      { value: "x" },
      undefined,
      { afterMs: 30, detach },
    );
    expect(execution.result.content[0]).toEqual({ type: "text", text: "completed-before-detach" });
    expect(detach).not.toHaveBeenCalled();
    const events = (
      await k.db.pool.query(
        "select payload from run_events where run_id=$1 and type='tool' order by seq",
        [ctx.run.id],
      )
    ).rows.map((r) => r.payload.status);
    expect(events).toEqual(["running", "complete"]);
    measurements.boundary = { events, falseBackgroundReceipt: false };
  } finally {
    gate.resolve();
    spy.mockRestore();
  }
  await k.runs.finish(ctx.run, "succeeded");
});

it("bounds an uncooperative effect, fences its late result, and does not treat returned JSON as control", async () => {
  const { ctx } = await prepared();
  const gate = deferred();
  k.runs.limits.toolTimeoutMs = 40;
  let signal: AbortSignal | undefined;
  const execution = await invokeTool(
    ctx,
    slow(
      async (_id, _args, s) => {
        signal = s;
        await gate.promise;
        return result("late-success");
      },
      { effect: "external" },
    ),
    "turn:call-0",
    { value: "x" },
  );
  expect(execution.waiting).toBe("unknown");
  expect(signal!.aborted).toBe(true);
  gate.resolve();
  await delay(20);
  const row = (
    await k.db.pool.query("select id,state from tool_calls where run_id=$1", [ctx.run.id])
  ).rows[0];
  expect(row.state).toBe("unknown");
  const policy = await k.runs.settings.read();
  await k.runs.settings.save(policy.revision, { ...policy.policy, toolsPerAgent: 1 });
  let dispatched = 0;
  const blocked = await invokeTool(
    ctx,
    slow(async () => {
      dispatched++;
      return result("unexpected");
    }),
    "quota",
    { value: "x" },
  );
  expect(blocked.result.isError).toBe(true);
  expect(dispatched).toBe(0);
  const updated = await k.runs.settings.read();
  await k.runs.settings.save(updated.revision, policy.policy);
  const independent = await prepared();
  const data = await invokeTool(
    independent.ctx,
    slow(async () =>
      result('{"status":"pending","requestId":"not-an-approval","waitingForMessage":true}'),
    ),
    "plain-json",
    { value: "x" },
  );
  expect(data.waiting).toBeUndefined();
  expect(data.result.isError).not.toBe(true);
  expect(data.result.content[0]).toEqual({
    type: "text",
    text: '{"status":"pending","requestId":"not-an-approval","waitingForMessage":true}',
  });
  let waits = 0;
  const waiter = slow(async () => {
    waits++;
    return result({ waitingForMessage: true });
  });
  expect((await invokeTool(independent.ctx, waiter, "wait", { value: "x" })).waiting).toBe(
    "message",
  );
  expect((await invokeTool(independent.ctx, waiter, "wait", { value: "x" })).waiting).toBe(
    "message",
  );
  expect(waits).toBe(1);
  await k.runs.finish(ctx.run, "waiting", undefined, "unknown");
  await k.conversations.resolveUnknown(row.id, "abandon", "late effect verified by fixture");
  await k.runs.cancel(ctx.run.id);
  await k.runs.finish(independent.ctx.run, "succeeded");
  measurements.deadline = {
    signalAborted: true,
    afterLateCompletion: row.state,
    dataCannotChangeControlFlow: true,
    unknownBlocksOnlyItsConversation: true,
    restoredWaitExecutions: waits,
  };
});

it("keeps ordinary progress visible without waking inference and waits without canvas write locks", async () => {
  const { ctx, submitted } = await prepared();
  k.runs.limits.toolNoticeMs = 60000;
  const gate = deferred();
  const execution = k.conversations.execute(ctx, async () => [
    slow(async () => {
      await gate.promise;
      return result("FINAL-PROGRESS");
    }),
  ]);
  try {
    await until(async () =>
      (await k.conversations.read.history(submitted.conversationId)).some(
        (m) => m.role === "assistant",
      ),
    );
    const call = (await k.db.pool.query("select id from tool_calls where run_id=$1", [ctx.run.id]))
      .rows[0];
    await k.db.canvas(ctx.run.canvas_id, async (tx) => {
      for (let i = 0; i < 32; i++)
        await k.conversations.append(
          tx,
          submitted.conversationId,
          `progress-${i}`,
          "tool_update",
          { callId: call.id, status: "dispatching", progress: true, text: `仍在执行 ${i}` },
          ctx.run.id,
        );
    });
    // Enter the stable idle state before measuring locks; the transition itself
    // intentionally publishes the background wait reason once.
    await until(async () => (await k.runs.get(ctx.run.id)).reason === "background");
    const writes = vi.spyOn(k.db, "canvas");
    // Notice is not due, so the waiting loop should remain read-only.
    await k.db.pool.query(
      "update tool_calls set next_notice_at=now()+interval '1 minute' where run_id=$1",
      [ctx.run.id],
    );
    await delay(1200);
    const writeTransactions = writes.mock.calls.length;
    writes.mockRestore();
    expect(writeTransactions).toBe(0);
    const before = (await k.conversations.read.history(submitted.conversationId)).filter(
      (m) => m.role === "assistant",
    ).length;
    expect(before).toBe(1);
    gate.resolve();
    await execution;
    const after = (await k.conversations.read.history(submitted.conversationId)).filter((m) =>
      ["assistant", "internal_note"].includes(m.role),
    ).length;
    expect(after).toBe(2);
    measurements.progress = {
      notices: 32,
      modelTurnsWhileWaiting: before,
      totalModelTurns: after,
      idleCanvasWriteTransactions: writeTransactions,
    };
  } finally {
    gate.resolve();
    await execution;
  }
});

it("ablation: batches opted-in reads but preserves the order of effects", async () => {
  const samples = [];
  for (const parallel of [false, true]) {
    const { ctx } = await prepared(4);
    const gate = deferred();
    let calls = 0;
    k.runs.limits.toolAsyncAfterMs = 80;
    const started = performance.now();
    let receiptMs = 0;
    let startedAtReceipt = 0;
    const original = Agent.prototype.turn;
    const spy = vi.spyOn(Agent.prototype, "turn").mockImplementationOnce(async function (
      this: Agent,
      ...args
    ) {
      receiptMs = performance.now() - started;
      startedAtReceipt = calls;
      gate.resolve();
      return original.apply(this, args);
    });
    try {
      await k.conversations.execute(ctx, async () => [
        slow(
          async () => {
            calls++;
            await gate.promise;
            return result("done");
          },
          { parallel },
        ),
      ]);
    } finally {
      gate.resolve();
      spy.mockRestore();
    }
    expect(calls).toBe(4);
    expect(startedAtReceipt).toBe(parallel ? 4 : 1);
    samples.push({ parallel, receiptMs: Math.round(receiptMs), calls, startedAtReceipt });
  }
  const { ctx } = await prepared(2);
  let counter = 0;
  await k.conversations.execute(ctx, async () => [
    slow(
      async () => {
        const before = counter;
        await delay(10);
        counter = before + 1;
        return result(counter);
      },
      { effect: "external", parallel: true },
    ),
  ]);
  expect(counter).toBe(2);
  measurements.parallel = { samples, effectCounter: counter };
});

it("summarizes before background work ends and reports the late result without new tools", async () => {
  k.runs.limits.conversationTurns = 32;
  const { ctx, template, submitted } = await prepared();
  const gate = deferred();
  let executions = 0,
    turns = 0;
  const spy = vi.spyOn(Agent.prototype, "turn").mockImplementation(async function (this: Agent) {
    turns++;
    if (turns === 33) {
      expect(this.state.tools).toHaveLength(0);
      expect(JSON.stringify(this.state.messages)).not.toContain("FINAL-AT-LIMIT");
    }
    if (turns === 34) {
      expect(this.state.tools).toHaveLength(0);
      expect(JSON.stringify(this.state.messages)).toContain("FINAL-AT-LIMIT");
    }
    const message: any = {
      ...template,
      content:
        turns <= 32
          ? [
              {
                type: "toolCall",
                id: `next-${turns}`,
                name: "slow",
                arguments: { value: String(turns) },
              },
            ]
          : [
              {
                type: "text",
                text: addressedOutput(
                  this.state.systemPrompt,
                  "完成汇总",
                  turns === 33 ? "update" : "result",
                ),
              },
            ],
      stopReason: turns <= 32 ? "toolUse" : "stop",
    };
    this.state.messages.push(message);
    return message;
  });
  const execution = k.conversations.execute(ctx, async () => [
    slow(
      async (_id, args) => {
        executions++;
        if (args.value === "0") {
          await gate.promise;
          return result("FINAL-AT-LIMIT");
        }
        return result("fast");
      },
      { parallel: true },
    ),
  ]);
  void execution.catch(() => {});
  try {
    await until(() => executions === 33);
    await until(() => turns === 33);
    gate.resolve();
    await execution;
  } finally {
    gate.resolve();
    await execution;
    spy.mockRestore();
  }
  expect(turns).toBe(34);
  expect(executions).toBe(33);
  expect(
    (await k.conversations.read.history(submitted.conversationId)).some(
      (m) => m.role === "assistant" && m.content.text === "完成汇总",
    ),
  ).toBe(true);
  expect((await k.runs.get(ctx.run.id)).state).toBe("waiting");
  await k.runs.cancel(ctx.run.id);
  measurements.roundLimit = {
    modelTurns: turns,
    summaryTurns: 2,
    summaryCanCallTools: false,
    finalResultConsumed: true,
  };
});

it.skipIf(process.platform === "win32")(
  "cancellation terminates the actual host command",
  async () => {
    const abort = new AbortController();
    const pidFile = join(dir, "command.pid");
    const child = runProcess(
      "/bin/sh",
      ["-c", `echo $$ > '${pidFile}'; exec sleep 60`],
      dir,
      { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      abort.signal,
    );
    void child.catch(() => {});
    let pid = 0;
    try {
      await until(async () => {
        try {
          pid = Number(await readFile(pidFile, "utf8"));
          return pid > 0;
        } catch {
          return false;
        }
      });
      abort.abort(new Error("stop fixture"));
      await expect(child).rejects.toThrow();
      await until(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      });
      measurements.hostCancellation = { commandExited: true };
    } finally {
      abort.abort();
      await child.catch(() => {});
    }
  },
);
