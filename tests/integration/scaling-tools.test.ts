import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { Type } from "typebox";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Database } from "../../apps/server/dist/adapters/postgres/database.js";
import { DEFAULT_LIMITS } from "../../apps/server/dist/modules/execution/limits.js";
import { invokeTool, result } from "../../apps/server/dist/modules/execution/tool-calls.js";
import { Worker } from "../../apps/server/dist/modules/execution/worker.js";

const key = () => randomUUID();
const adminUrl = process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres";
const name = `intrica_scale_${key().replaceAll("-", "")}`;
let app: Awaited<ReturnType<typeof buildServer>>, k: Kernel, dir: string, admin: pg.Client;
async function until(check: () => Promise<boolean>, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error("condition not reached");
}
const canvas = async () =>
  (await k.graph.createCanvas({ title: "scaling", idempotencyKey: key() })).node.id;
beforeAll(async () => {
  await mkdir(resolve("test-results"), { recursive: true });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  dir = await mkdtemp(join(tmpdir(), "intrica-scale-"));
  app = await buildServer({
    databaseUrl: url.href,
    dataDir: dir,
    accessToken: key(),
    worker: false,
    model: { kind: "mock", streamDelayMs: 0, supportsVision: false },
    execution: { ...DEFAULT_LIMITS, toolAsyncAfterMs: 50, toolNoticeMs: 80, toolTimeoutMs: 60000 },
  });
  await app.ready();
  k = app.kernel;
});
afterAll(async () => {
  await app?.close();
  await admin.query(`drop database if exists ${name} with(force)`);
  await admin.end();
  if (dir) await rm(dir, { recursive: true, force: true });
});

it("upgrades the published schema without discarding graph data", async () => {
  const migrationName = `intrica_migration_${key().replaceAll("-", "")}`;
  await admin.query(`create database ${migrationName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${migrationName}`;
  const db = new Database(url.href);
  try {
    await db.pool.query("create schema intrica");
    await db.pool.query(
      await readFile(new URL("../fixtures/schema-v5.sql", import.meta.url), "utf8"),
    );
    await db.pool.query("insert into canvases(id,title) values('migration-canvas','preserved')");
    await db.pool.query(`
      insert into nodes(id,canvas_id,sort_key,kind,body,x,y,w,h) values('old-agent','migration-canvas',1,'agent','{}',0,0,200,200),('old-resource','migration-canvas',2,'text','{}',0,0,200,200);
      insert into agent_configs(node_id,config,enabled) values('old-agent','{"role":"read","enabled":false,"persona":""}',false);
      insert into grants(id,canvas_id,subject_id,resource_id,mode) values('old-read','migration-canvas','old-agent','old-resource','read'),('old-write','migration-canvas','old-agent','old-resource','write');
      insert into approvals(id,canvas_id,subject_id,action_digest,action,policy_revision,status,expires_at,reason) values('old-approval','migration-canvas','old-agent','old','{"tool":"request_permission","args":{"role":"write"}}',0,'pending',now()+interval '1 hour','legacy');
    `);
    await db.migrate();
    expect((await db.pool.query("select mode,source_link_id from grants")).rows).toEqual([
      { mode: "write", source_link_id: expect.any(String) },
    ]);
    expect(
      (await db.pool.query("select status from approvals where id='old-approval'")).rows[0].status,
    ).toBe("cancelled");
    expect((await db.pool.query("select version from schema_info")).rows[0].version).toBe(15);
    expect(
      (await db.pool.query("select title from canvases where id='migration-canvas'")).rows[0].title,
    ).toBe("preserved");
  } finally {
    await db.pool.end();
    await admin.query(`drop database if exists ${migrationName} with(force)`);
  }
});

it("T16 schema upgrades preserve approval identity and resource provenance", async () => {
  const migrationName = `intrica_v6_${key().replaceAll("-", "")}`;
  await admin.query(`create database ${migrationName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${migrationName}`;
  const db = new Database(url.href);
  try {
    await db.pool.query("create schema intrica");
    await db.pool.query(
      await readFile(new URL("../fixtures/schema-v5.sql", import.meta.url), "utf8"),
    );
    await db.pool.query(
      await readFile(new URL("../../db/migrations/0006-approvals.sql", import.meta.url), "utf8"),
    );
    await db.pool.query(`
      insert into canvases(id,title) values('board','preserved');
      insert into nodes(id,canvas_id,sort_key,kind,body,x,y,w,h) values('agent','board',1,'agent','{}',0,0,200,200),('output','board',2,'text','{}',400,0,200,200);
      insert into agent_configs(node_id,config) values('agent','{"role":"read","enabled":false,"persona":""}');
      insert into conversations(id,canvas_id,agent_id) values('conversation','board','agent');
      insert into runs(id,canvas_id,subject_id,kind,state,frozen_input,cause_id) values('run','board','conversation','conversation','waiting','{}','run');
      insert into attempts(id,run_id,epoch,state,created_at) values('attempt','run',1,'waiting',now()-interval '1 minute');
      insert into tool_calls(id,run_id,attempt_id,logical_call_id,name,args,args_hash,effect_class,state) values('tool','run','attempt','call','request_permission','{}','hash','graph','waiting');
      insert into approvals(id,canvas_id,subject_id,origin_call_id,action,basis,status,expires_at,reason) values('approval','board','agent','tool','{"kind":"role","role":"write"}','{"role":"read"}','pending',now()+interval '1 hour','review');
      update tool_calls set approval_id='approval' where id='tool';
      insert into edges(id,canvas_id,from_id,to_id,kind,source_attempt_id) values('provenance','board','agent','output','derived_from','run');
      insert into grants(id,canvas_id,subject_id,resource_id,mode,source_link_id) values('grant','board','agent','output','read','provenance');
    `);
    await db.migrate();
    expect(
      (
        await db.pool.query(
          "select status,origin_call_id,version from approvals where id='approval'",
        )
      ).rows[0],
    ).toEqual({ status: "invalidated", origin_call_id: "tool", version: 2 });
    expect(
      (await db.pool.query("select state,approval_id from tool_calls where id='tool'")).rows[0],
    ).toEqual({ state: "failed", approval_id: "approval" });
    expect(
      (
        await db.pool.query(
          "select from_id,to_id,source_attempt_id from edges where id='provenance'",
        )
      ).rows[0],
    ).toEqual({ from_id: "output", to_id: "agent", source_attempt_id: "attempt" });
    expect((await db.pool.query("select delegated_by,source_link_id from grants")).rows[0]).toEqual(
      { delegated_by: null, source_link_id: "provenance" },
    );
    await db.migrate();
    await db.migrate();
    expect((await db.pool.query("select version from schema_info")).rows[0].version).toBe(15);
  } finally {
    await db.close();
    await admin.query(`drop database if exists ${migrationName} with(force)`);
  }
});

it("admits 64 active Agent conversations plus independent generation capacity", async () => {
  const c = await canvas(),
    other = await canvas();
  const agents = [];
  for (let i = 0; i < 65; i++)
    agents.push(
      (
        await k.graph.createNode({
          kind: "agent",
          parentId: c,
          title: `Agent ${i}`,
          agent: { persona: "controlled concurrency check", role: "read", enabled: false },
          position: { x: i * 260, y: 0, width: 240, height: 320 },
          idempotencyKey: key(),
        })
      ).node.id,
    );
  const submitted = await Promise.all(
    agents.map((agentId, i) =>
      k.conversations.submit({ canvasId: c, agentId, message: `Agent ${i}`, key: key() }),
    ),
  );
  for (const board of [c, other])
    for (let i = 0; i < 5; i++)
      await k.db.canvas(board, (tx) =>
        k.runs.enqueue(tx, { canvasId: board, subjectId: key(), kind: "generation", frozen: {} }),
      );
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const handler = async (ctx: any) => {
    await gate;
    await ctx.store.finish(ctx.run, "succeeded");
  };
  const conversation = async (ctx: any) =>
    k.conversations.execute(ctx, async () => [
      {
        name: "read_canvas",
        label: "read",
        description: "controlled long tool",
        parameters: Type.Object({}),
        effect: "read",
        execute: async () => {
          await gate;
          return result("canvas result");
        },
      },
    ]);
  const worker = new Worker(k.runs, { generation: handler, conversation }, async () => {});
  const oldNotice = k.runs.limits.toolNoticeMs;
  k.runs.limits.toolNoticeMs = 60000;
  const started = performance.now();
  worker.start();
  try {
    await until(
      async () =>
        (await k.db.pool.query("select count(*)::int as n from runs where state='running'")).rows[0]
          .n === 72,
    );
    await until(
      async () =>
        (
          await k.db.pool.query(
            "select count(*)::int as n from tool_calls where is_async and state='dispatching'",
          )
        ).rows[0].n === 64,
    );
    await until(
      async () =>
        (
          await k.db.pool.query(
            "select count(distinct conversation_id)::int as n from messages where role='model_output' and content->>'stopReason'='stop'",
          )
        ).rows[0].n === 64,
    );
    const admissionMs = performance.now() - started;
    await delay(5500);
    const renewed = (
      await k.db.pool.query(
        "select count(*)::int as n from runs where state='running' and lease_until>clock_timestamp()+interval '25 seconds'",
      )
    ).rows[0].n;
    expect(renewed).toBe(72);
    const counts = (
      await k.db.pool.query(
        "select kind,count(*)::int as n from runs where state='running' group by kind",
      )
    ).rows;
    expect(counts.find((r) => r.kind === "conversation")?.n).toBe(64);
    expect(counts.find((r) => r.kind === "generation")?.n).toBe(8);
    expect(
      (
        await k.db.pool.query(
          "select count(*)::int as n from runs where state='running' and kind='generation' and canvas_id=$1",
          [c],
        )
      ).rows[0].n,
    ).toBe(4);
    await writeFile(
      resolve("test-results/concurrency-results.json"),
      `${JSON.stringify(
        {
          date: new Date().toISOString(),
          agents: 64,
          generations: 8,
          generationsPerCanvas: 4,
          admissionMs,
          renewedLeases: renewed,
          kind: "real PostgreSQL, Worker, Agent identities and Conversations; 64 mock model sessions produce replies while their original tools remain active; 8 controlled generation handlers",
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    release();
    await until(
      async () =>
        (
          await k.db.pool.query(
            "select count(*)::int as n from runs where state in('queued','running')",
          )
        ).rows[0].n === 0,
    );
    await worker.close();
    k.runs.limits.toolNoticeMs = oldNotice;
  }
  expect(submitted).toHaveLength(65);
});

async function prepared() {
  const c = await canvas();
  const submitted = await k.conversations.submit({
    canvasId: c,
    message: "请执行工具，然后继续汇报",
    key: key(),
  });
  const run = (await k.runs.claim("tools"))!;
  const message = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "provider-call", name: "slow", arguments: { value: "retained" } },
    ],
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
      JSON.stringify([message]),
      JSON.stringify({ pendingTurnId: "saved-turn" }),
    ],
  );
  return { c, submitted, run };
}
it("detaches without restarting, notifies periodically, and returns results into durable context", async () => {
  const { submitted, run } = await prepared();
  let release!: () => void;
  let calls = 0;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const tool = {
    name: "slow",
    label: "slow",
    description: "test",
    parameters: Type.Object({ value: Type.String() }),
    effect: "read" as const,
    execute: async (_id: string, args: any) => {
      calls++;
      await gate;
      return result(`completed-${args.value}`);
    },
  };
  const execution = k.conversations.execute(
    { run, store: k.runs, signal: new AbortController().signal, progress() {} },
    async () => [tool],
  );
  try {
    await until(async () => {
      const view = await k.conversations.read.view(submitted.conversationId);
      return (
        view.messages.some((m) => m.role === "assistant") &&
        view.messages.some((m) => m.role === "tool_update")
      );
    });
    expect((await k.runs.get(run.id)).state).toBe("running");
    const row = (
      await k.db.pool.query("select checkpoint from conversations where id=$1", [
        submitted.conversationId,
      ])
    ).rows[0];
    expect(
      row.checkpoint.some(
        (m: any) =>
          m.role === "toolResult" &&
          m.toolCallId === "provider-call" &&
          m.content[0].text.includes("asynchronous"),
      ),
    ).toBe(true);
  } finally {
    release();
    await execution;
  }
  const final = await k.conversations.read.view(submitted.conversationId);
  expect(calls).toBe(1);
  expect(final.run).toMatchObject({ state: "succeeded" });
  expect(
    final.messages.filter(
      (m) => m.role === "tool_update" && m.content.text.includes("completed-retained"),
    ),
  ).toHaveLength(1);
  const checkpoint = (
    await k.db.pool.query("select checkpoint from conversations where id=$1", [
      submitted.conversationId,
    ])
  ).rows[0].checkpoint;
  expect(JSON.stringify(checkpoint)).toContain("completed-retained");
});
it("keeps uncertain asynchronous effects for explicit resolution after cancellation", async () => {
  const { submitted, run } = await prepared();
  const abort = new AbortController();
  let calls = 0;
  const execution = k.conversations.execute(
    { run, store: k.runs, signal: abort.signal, progress() {} },
    async () => [
      {
        name: "slow",
        label: "slow",
        description: "test",
        parameters: Type.Object({ value: Type.String() }),
        effect: "external",
        execute: async (_id, _args, signal) => {
          calls++;
          await delay(10000, undefined, { signal });
          return result("effect");
        },
      },
    ],
  );
  void execution.catch(() => {});
  await until(
    async () =>
      (await k.db.pool.query("select is_async from tool_calls where run_id=$1", [run.id])).rows[0]
        ?.is_async,
  );
  await k.runs.cancel(run.id);
  abort.abort();
  await expect(execution).rejects.toBeDefined();
  await k.runs.fail(run, new Error("stopped"));
  await k.runs.recover();
  const unknown = (await k.conversations.read.view(submitted.conversationId)).unknownTools![0];
  await k.conversations.resolveUnknown(unknown.id, "done", "user verified effect");
  expect(calls).toBe(1);
  expect(
    (await k.conversations.read.history(submitted.conversationId)).some(
      (m) => m.role === "tool_update" && m.content.text.includes("user verified effect"),
    ),
  ).toBe(true);
});
it("uses the real 30 second boundary while retaining the original tool call", async () => {
  const { submitted, run } = await prepared();
  const previous = k.runs.limits.toolAsyncAfterMs;
  k.runs.limits.toolAsyncAfterMs = 30000;
  // This test holds a real lease while no Worker watch loop is running.
  await k.db.pool.query("update runs set lease_until=now()+interval '90 seconds' where id=$1", [
    run.id,
  ]);
  let release!: () => void;
  let calls = 0;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const started = performance.now();
  const execution = k.conversations.execute(
    { run, store: k.runs, signal: new AbortController().signal, progress() {} },
    async () => [
      {
        name: "slow",
        label: "slow",
        description: "test",
        parameters: Type.Object({ value: Type.String() }),
        effect: "read",
        execute: async () => {
          calls++;
          await gate;
          return result("final");
        },
      },
    ],
  );
  try {
    await until(
      async () =>
        (await k.conversations.read.view(submitted.conversationId)).messages.some(
          (m) => m.role === "assistant",
        ),
      35000,
    );
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(30000);
    expect(elapsed).toBeLessThan(35000);
    expect(calls).toBe(1);
  } finally {
    release();
    await execution;
    k.runs.limits.toolAsyncAfterMs = previous;
  }
}, 45000);

it("resumes a persisted async call even when its pending receipt was not checkpointed", async () => {
  const { submitted, run } = await prepared();
  const { digest } = await import("../../apps/server/dist/adapters/postgres/database.js");
  await k.db.pool.query(
    "insert into tool_calls(id,run_id,attempt_id,logical_call_id,name,args,args_hash,effect_class,state,is_async) values($1,$2,$3,'saved-turn:provider-call','slow',$4,$5,'read','prepared',true)",
    [
      key(),
      run.id,
      run.attemptId,
      JSON.stringify({ value: "retained" }),
      digest({ value: "retained" }),
    ],
  );
  let calls = 0;
  await k.conversations.execute(
    { run, store: k.runs, signal: new AbortController().signal, progress() {} },
    async () => [
      {
        name: "slow",
        label: "slow",
        description: "recover",
        parameters: Type.Object({ value: Type.String() }),
        effect: "read",
        execute: async () => {
          calls++;
          await delay(180);
          return result("recovered once");
        },
      },
    ],
  );
  expect(calls).toBe(1);
  expect((await k.conversations.read.view(submitted.conversationId)).run).toMatchObject({
    state: "succeeded",
  });
});
it("hire derives management from the enterable spatial child", async () => {
  const c = await canvas();
  const manager = (
    await k.graph.createNode({
      kind: "agent",
      parentId: c,
      title: "manager",
      agent: { persona: "manager", role: "admin", enabled: true },
      position: { x: 0, y: 0, width: 240, height: 320 },
      idempotencyKey: key(),
    })
  ).node;
  const submitted = await k.conversations.submit({
    canvasId: c,
    agentId: manager.id,
    message: "hire",
    key: key(),
  });
  const run = (await k.runs.claim("hire"))!;
  const tools = await k.tools.create(
    { run, store: k.runs, signal: new AbortController().signal, progress() {} },
    run.frozen_input,
  );
  const response = await invokeTool(
    { run, store: k.runs, signal: new AbortController().signal, progress() {} },
    tools.find((t) => t.name === "hire_agent")!,
    "hire",
    {
      task: "Review assigned work",
      persona: "quality",
      role: "write",
      respondToResources: false,
    },
  );
  const child = JSON.parse((response.result.content[0] as any).text);
  const node = await k.graph.queries.node(child.id);
  expect(node.parentId).toBe(manager.id);
  expect(node.managerId).toBe(manager.id);
  const snapshot = await k.bootstrap(c);
  expect(snapshot.nodes.find((n) => n.id === manager.id)!.childOrder).toContain(node.id);
  await k.runs.finish(run, "succeeded");
  expect(submitted.run.id).toBe(run.id);
});
it("ablation compares a blocking tool with the same tool detached", async () => {
  const measurements = [];
  for (const threshold of [5000, 50]) {
    const { submitted, run } = await prepared();
    const prior = k.runs.limits.toolAsyncAfterMs;
    k.runs.limits.toolAsyncAfterMs = threshold;
    let calls = 0,
      finished = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = performance.now();
    const execution = k.conversations.execute(
      { run, store: k.runs, signal: new AbortController().signal, progress() {} },
      async () => [
        {
          name: "slow",
          label: "slow",
          description: "ablation",
          parameters: Type.Object({ value: Type.String() }),
          effect: "read",
          execute: async () => {
            calls++;
            await gate;
            finished = true;
            return result("same result");
          },
        },
      ],
    );
    void execution.catch(() => {});
    try {
      await until(async () => calls === 1);
      const hasReply = async () =>
        (await k.conversations.read.history(submitted.conversationId)).some(
          (m) => m.role === "assistant",
        );
      if (threshold === 5000) {
        // The tool is deliberately held, not merely sleeping for a short period
        // that a busy test process may miss. It cannot finish before release.
        expect(await hasReply()).toBe(false);
        release();
      }
      // In detached mode, observing the reply is what releases the tool. No
      // scheduling delay can turn the expected ordering into a false failure.
      await until(hasReply);
      measurements.push({
        thresholdMs: threshold,
        firstReplyMs: performance.now() - started,
        repliedBeforeCompletion: !finished,
        calls,
      });
    } finally {
      release();
      try {
        await execution;
      } finally {
        k.runs.limits.toolAsyncAfterMs = prior;
      }
    }
    expect((await k.runs.get(run.id)).state).toBe("succeeded");
    expect(
      (await k.db.pool.query("select is_async from tool_calls where run_id=$1", [run.id])).rows,
    ).toEqual([{ is_async: threshold === 50 }]);
  }
  expect(measurements[0]!.repliedBeforeCompletion).toBe(false);
  expect(measurements[1]!.repliedBeforeCompletion).toBe(true);
  expect(measurements.every((m) => m.calls === 1)).toBe(true);
  await writeFile(
    resolve("test-results/async-tools-results.json"),
    `${JSON.stringify(
      { date: new Date().toISOString(), toolCompletion: "explicit gate", measurements },
      null,
      2,
    )}\n`,
  );
});

it("parks before external dispatch and resumes the same model tool after approval", async () => {
  const { c, run } = await prepared();
  const agent = (
    await k.graph.createNode({
      kind: "agent",
      parentId: c,
      title: "approval",
      agent: { role: "read", enabled: false, persona: "" },
      position: { x: 0, y: 0, width: 240, height: 160 },
      idempotencyKey: key(),
    })
  ).node;
  let calls = 0,
    requestId = "";
  const factory = async (ctx: any) => [
    {
      name: "slow",
      label: "slow",
      description: "approval boundary",
      parameters: Type.Object({ value: Type.String() }),
      effect: "external" as const,
      prepare: async (tx: any, callId: string) => {
        if ((await k.graph.queries.node(agent.id, tx)).agent!.role === "write") return;
        const pending = await k.access.gate(
          tx,
          { kind: "agent", agentId: agent.id, runId: ctx.run.id, epoch: ctx.run.epoch },
          callId,
          { kind: "role", role: "write" },
          "test",
        );
        requestId = pending?.control?.approvalId ?? "";
        return pending;
      },
      execute: async () => {
        calls++;
        return result("approved and resumed");
      },
    },
  ];
  const context = (lease: any) => ({
    run: lease,
    store: k.runs,
    signal: new AbortController().signal,
    progress() {},
  });
  await k.conversations.execute(context(run), factory);
  expect(calls).toBe(0);
  expect((await k.runs.get(run.id)).state).toBe("waiting");
  await k.access.decide(requestId, 1, "approve", "allowed");
  const resumed = (await k.runs.claim("approved"))!;
  expect(resumed.id).toBe(run.id);
  await k.conversations.execute(context(resumed), factory);
  expect(calls).toBe(1);
  expect((await k.runs.get(run.id)).state).toBe("succeeded");
});
