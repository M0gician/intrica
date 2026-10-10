import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRole, Node } from "@intrica/contracts";
import { buildServer, DomainError, type Kernel } from "@intrica/server";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { digest } from "../../apps/server/dist/adapters/postgres/database.js";
import { resolveTarget } from "../../apps/server/dist/modules/collaboration/resolve-target.js";
import { DEFAULT_LIMITS } from "../../apps/server/dist/modules/execution/limits.js";
import type { Lease } from "../../apps/server/dist/modules/execution/store.js";
import { invokeTool } from "../../apps/server/dist/modules/execution/tool-calls.js";
import { InboxScheduler } from "../../apps/server/dist/modules/work/inbox-scheduler.js";
import { wireOutput } from "../fixtures/addressed-output.mjs";

// Model decisions alone are scripted. Tools, permissions, inboxes, transactions and
// conversation execution all use production code. Failed contracts are not skipped/xfail.
const key = () => randomUUID();
const dbName = `intrica_collaboration_${key().replaceAll("-", "")}`;
let app: Awaited<ReturnType<typeof buildServer>>, k: Kernel, dir: string, admin: pg.Client;
let provider: Server, board: string;
type WireMessage = { role: string; content: string; name?: string };
type WireRequest = { messages: WireMessage[] };
type Reply = { output: object } | { text: string } | { tool: string; args: object };
let respond: (request: WireRequest) => Reply;
let requests: WireRequest[];

beforeAll(async () => {
  provider = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as WireRequest;
    requests.push(request);
    const reply = respond(request);
    const tool = "tool" in reply;
    const delta = tool
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: key(),
              type: "function",
              function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
            },
          ],
        }
      : {
          role: "assistant",
          content:
            "output" in reply
              ? JSON.stringify(reply.output)
              : wireOutput(request.messages, reply.text),
        };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: key(), object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.end(`${chunk(delta, null)}${chunk({}, tool ? "tool_calls" : "stop")}data: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const adminUrl = process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres";
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  dir = await mkdtemp(join(tmpdir(), "intrica-collaboration-"));
  app = await buildServer({
    databaseUrl: url.href,
    dataDir: dir,
    accessToken: key(),
    worker: false,
    model: {
      kind: "pi",
      provider: "openai",
      modelId: "collaboration-fixture",
      apiKey: "fixture-only",
      baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
      supportsVision: false,
    },
    execution: { ...DEFAULT_LIMITS },
  });
  await app.ready();
  k = app.kernel;
});
beforeEach(async () => {
  requests = [];
  respond = () => ({ text: "acknowledged" });
  board = (await k.graph.createCanvas({ title: "collaboration", idempotencyKey: key() })).node.id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await k.db.pool.query("update conversations set consumed_message_seq=message_seq");
  await k.db.pool.query(
    "update messages set content=content||'{\"closed\":true}'::jsonb where consumed_run_id is null",
  );
  await k.db.pool.query("update approvals set status='cancelled' where status='pending'");
  await k.db.pool.query(
    "update runs set state='cancelled',cancel_requested_at=now() where state in('queued','running','waiting')",
  );
  await k.db.pool.query("update schedules set enabled=false");
  Object.assign(k.runs.limits, DEFAULT_LIMITS);
  const settings = await k.runs.settings.read();
  await k.runs.settings.save(settings.revision, {
    ...settings.policy,
    pendingPerCanvas: DEFAULT_LIMITS.pendingPerCanvas,
  });
});
afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => provider?.close(() => resolve()));
  await admin.query(`drop database if exists ${dbName} with(force)`);
  await admin.end();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const rect = { x: 0, y: 0, width: 220, height: 300 };
const agent = async (
  parentId = board,
  role: AgentRole = "write",
  enabled = true,
  persona = "member",
) =>
  (
    await k.graph.createNode({
      kind: "agent",
      parentId,
      title: key(),
      agent: { role, enabled, persona },
      position: rect,
      idempotencyKey: key(),
    })
  ).node;
const resource = async (parentId = board) =>
  (
    await k.graph.createNode({
      kind: "text",
      parentId,
      title: "shared",
      text: "fixture",
      position: rect,
      idempotencyKey: key(),
    })
  ).node;
const connect = (a: Node, r: Node) =>
  k.graph.createLink({ fromId: a.id, toId: r.id, idempotencyKey: key() });
const incoming = async (a: Node) =>
  (
    await k.db.pool.query(
      "select m.* from messages m join conversations c on c.id=m.conversation_id where c.agent_id=$1 and m.role='message' and m.content ? 'from' order by m.seq",
      [a.id],
    )
  ).rows;
const runs = async (a: Node) =>
  (
    await k.db.pool.query(
      "select r.* from runs r join conversations c on c.id=r.subject_id where c.agent_id=$1 order by r.created_at,r.id",
      [a.id],
    )
  ).rows;
const context = (run: Lease) => ({
  run,
  store: k.runs,
  signal: new AbortController().signal,
  progress() {},
});
async function start(a: Node) {
  const submitted = await k.conversations.submit({
    canvasId: a.canvasId!,
    agentId: a.id,
    message: "start",
    key: key(),
    language: "zh-CN",
  });
  const run = (await k.runs.claim("collaboration"))!;
  expect(run?.id).toBe(submitted.run.id);
  const ctx = context(run),
    tools = await k.tools.create(ctx, run.frozen_input);
  return {
    run,
    ctx,
    tools,
    call: async (name: string, args: object, logical: string = key()) => {
      const outcome = await invokeTool(ctx, tools.find((t) => t.name === name)!, logical, args);
      const text = (outcome.result.content[0] as { text: string }).text;
      let value: any;
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
      return { ...outcome, value, logical };
    },
  };
}
async function executeNext(a: Node, claimed?: Lease) {
  const lease = claimed ?? (await k.runs.claim("recipient"))!;
  expect(lease?.frozen_input.agentId).toBe(a.id);
  const ctx = context(lease);
  await k.conversations.execute(ctx, (ctx, input) => k.tools.create(ctx, input));
  return k.runs.get(lease.id);
}
async function consume(a: Node, text: string, claimed?: Lease) {
  const completed = await executeNext(a, claimed);
  expect(completed.state).toBe("succeeded");
  const c = await k.conversations.read.forAgent(a.id);
  const row = (
    await k.db.pool.query("select checkpoint,consumed_message_seq from conversations where id=$1", [
      c.id,
    ])
  ).rows[0];
  expect(JSON.stringify(row.checkpoint)).toContain(text);
  expect(Number(row.consumed_message_seq)).toBeGreaterThanOrEqual(
    Number((await incoming(a)).at(-1).seq),
  );
  expect(requests.some((r) => JSON.stringify(r.messages).includes(text))).toBe(true);
}
async function approve(requestId: string, decision: "approve" | "deny" = "approve") {
  const row = (await k.db.pool.query("select version from approvals where id=$1", [requestId]))
    .rows[0];
  return k.access.decide(requestId, row.version, decision, "test decision");
}
async function pausedCapture(work: () => Promise<unknown>) {
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = k.conversations.models.capture.bind(k.conversations.models);
  const spy = vi
    .spyOn(k.conversations.models, "capture")
    .mockImplementationOnce(async (...args) => {
      reached();
      await gate;
      return original(...args);
    });
  const maintenance = k.maintain();
  try {
    await entered;
    await work();
  } finally {
    release();
    await maintenance;
    spy.mockRestore();
  }
}

it.each(["down", "up", "siblings", "other-team"] as const)(
  "C01 point-to-point %s reaches model input and completes once",
  async (direction) => {
    const parent = await agent(),
      other = await agent();
    const child = await agent(parent.id),
      sibling = await agent(parent.id),
      cousin = await agent(other.id);
    const [from, to] =
      direction === "down"
        ? [parent, child]
        : direction === "up"
          ? [child, parent]
          : direction === "siblings"
            ? [child, sibling]
            : [child, cousin];
    const s = await start(from),
      text = `task-${direction}`;
    expect(
      (
        await s.call("send_message", {
          kind: "update",
          target: { kind: "agent", agentId: to.id },
          message: text,
        })
      ).value.delivered,
    ).toBe(1);
    await k.maintain();
    expect(await runs(to)).toHaveLength(1);
    expect((await incoming(to))[0].run_id).toBe((await runs(to))[0].id);
    await consume(to, text);
    await k.maintain();
    expect(await runs(to)).toHaveLength(1);
    expect(await incoming(to)).toHaveLength(1);
  },
);

it.each(["message", "report", "broadcast"])(
  "C02 explicit %s activates an on-demand recipient",
  async (tool) => {
    const to = await agent(board, "write", false),
      from = await agent(to.id);
    const r = await resource();
    await connect(from, r);
    await connect(to, r);
    const s = await start(from),
      message = `on-demand-${tool}`;
    const args =
      tool === "message"
        ? { kind: "update", target: { kind: "agent", agentId: to.id }, message }
        : tool === "broadcast"
          ? { kind: "update", target: { kind: "resource_readers", resourceIds: [r.id] }, message }
          : { message };
    expect(
      (
        await s.call("send_message", {
          kind: tool === "report" ? "result" : "update",
          ...args,
          ...(tool === "report" ? { target: { kind: "manager" } } : {}),
        })
      ).value.delivered,
    ).toBe(1);
    await k.maintain();
    expect(await runs(to)).toHaveLength(1);
    await consume(to, message);
  },
);

it("C03 report_result goes only to the current direct manager and stops at ordinary containers", async () => {
  const root = await agent(),
    manager = await agent(root.id),
    child = await agent(manager.id);
  const s = await start(child);
  expect(
    (
      await s.call("send_message", {
        kind: "result",
        target: { kind: "manager" },
        message: "direct",
      })
    ).value.recipients,
  ).toEqual([manager.id]);
  expect(await incoming(root)).toHaveLength(0);
  await k.maintain();
  await consume(manager, "direct");
  const folder = await resource(root.id);
  await k.graph.submitMove({
    targetParentId: folder.id,
    moves: [{ nodeId: child.id, x: 10, y: 10 }],
    idempotencyKey: key(),
  });
  expect(
    (
      await s.call("send_message", {
        kind: "result",
        target: { kind: "manager" },
        message: "local-only",
      })
    ).result.isError,
  ).toBe(true);
  expect(await incoming(root)).toHaveLength(0);
  expect(await incoming(manager)).toHaveLength(1);
});

it("C04 a child may message and report upward without acquiring the manager's execution role", async () => {
  const manager = await agent(board, "admin"),
    child = await agent(manager.id, "read");
  const s = await start(child);
  const task = await s.call("send_message", {
    kind: "update",
    target: { kind: "agent", agentId: manager.id },
    message: "execute privileged work",
  });
  expect(task.waiting).toBeUndefined();
  expect(await incoming(manager)).toHaveLength(1);
  expect(
    (
      await s.call("send_message", {
        kind: "result",
        target: { kind: "manager" },
        message: "read-only result",
      })
    ).value.delivered,
  ).toBe(1);
  await k.maintain();
  await consume(manager, "read-only result");
  expect((await k.graph.queries.node(child.id)).agent!.role).toBe("read");
});

it("C05 broadcast intersects all resource grants across hierarchy, excludes self and deduplicates", async () => {
  const parent = await agent(),
    from = await agent(parent.id),
    sibling = await agent(parent.id),
    child = await agent(from.id),
    outside = await agent();
  const partial = await agent(),
    none = await agent(),
    r1 = await resource(),
    r2 = await resource();
  for (const a of [parent, from, sibling, child, outside]) {
    await connect(a, r1);
    await connect(a, r2);
  }
  await connect(partial, r1);
  const s = await start(from),
    args = {
      kind: "update",
      target: { kind: "resource_readers", resourceIds: [r1.id, r2.id, r1.id] },
      message: "all scopes",
    };
  const first = await s.call("send_message", args, "broadcast-once");
  const replay = await s.call("send_message", args, "broadcast-once");
  expect(first.value).toEqual(replay.value);
  expect(first.value.recipients).toEqual([parent, sibling, child, outside].map((a) => a.id).sort());
  await k.maintain();
  for (const a of [parent, sibling, child, outside]) {
    expect(await incoming(a)).toHaveLength(1);
    expect(await runs(a)).toHaveLength(1);
  }
  for (const a of [from, partial, none]) expect(await incoming(a)).toHaveLength(0);
  const remaining = new Map([parent, sibling, child, outside].map((a) => [a.id, a]));
  while (remaining.size) {
    const lease = (await k.runs.claim("broadcast"))!;
    const recipient = remaining.get(lease?.frozen_input.agentId);
    expect(recipient).toBeDefined();
    await consume(recipient!, "all scopes", lease);
    remaining.delete(recipient!.id);
  }
  await k.maintain();
  expect(await k.runs.claim("broadcast-drained")).toBeNull();
});

it("C06 empty broadcasts succeed without activations and inaccessible resources never fan out", async () => {
  const from = await agent(),
    r = await resource(),
    s = await start(from);
  const denied = await s.call("send_message", {
    kind: "update",
    target: { kind: "resource_readers", resourceIds: [r.id] },
    message: "denied",
  });
  expect(denied.result.isError).toBe(true);
  await connect(from, r);
  expect(
    (
      await s.call("send_message", {
        kind: "update",
        target: { kind: "resource_readers", resourceIds: [r.id] },
        message: "none",
      })
    ).value.delivered,
  ).toBe(0);
  await k.maintain();
  expect(
    (await k.db.pool.query("select activation_count from runs where id=$1", [s.run.id])).rows[0]
      .activation_count,
  ).toBe(0);
});

it.each(["approve", "deny"] as const)(
  "C07 mixed-privilege broadcast is atomic on %s and one approval cannot authorize a new call",
  async (decision) => {
    const from = await agent(),
      peer = await agent(),
      privileged = await agent(board, "admin"),
      r = await resource();
    for (const a of [from, peer, privileged]) await connect(a, r);
    const s = await start(from),
      args = {
        kind: "update",
        target: { kind: "resource_readers", resourceIds: [r.id] },
        message: "broadcast",
      };
    const pending = await s.call("send_message", args, "approved-once");
    expect(pending.waiting).toBe("approval");
    for (const a of [peer, privileged]) expect(await incoming(a)).toHaveLength(0);
    await approve(pending.value.requestId, decision);
    await s.call("send_message", args, "approved-once");
    for (const a of [peer, privileged])
      expect(await incoming(a)).toHaveLength(decision === "approve" ? 1 : 0);
    expect((await s.call("send_message", args, "new-call")).waiting).toBe("approval");
  },
);

it("C08 approving a frozen broadcast excludes newly joined recipients", async () => {
  const from = await agent(),
    to = await agent(board, "admin"),
    late = await agent(board, "admin"),
    r = await resource();
  await connect(from, r);
  await connect(to, r);
  const s = await start(from),
    args = {
      kind: "update",
      target: { kind: "resource_readers", resourceIds: [r.id] },
      message: "frozen recipients",
    };
  const pending = await s.call("send_message", args);
  await connect(late, r);
  await approve(pending.value.requestId);
  expect((await s.call("send_message", args, pending.logical)).value.recipients).toEqual([to.id]);
  expect(await incoming(late)).toHaveLength(0);
});

it("C09 revoking a recipient resource invalidates a pending broadcast without partial delivery", async () => {
  const from = await agent(),
    to = await agent(board, "admin"),
    r = await resource();
  await connect(from, r);
  const edge = await connect(to, r);
  const s = await start(from),
    pending = await s.call("send_message", {
      kind: "update",
      target: { kind: "resource_readers", resourceIds: [r.id] },
      message: "stale",
    });
  await k.graph.deleteLink(edge.edge.id, { idempotencyKey: key() });
  await expect(approve(pending.value.requestId)).rejects.toMatchObject({
    code: "VERSION_CONFLICT",
  });
  expect(await incoming(to)).toHaveLength(0);
});

it("C10 report approval is invalidated when the member changes managers", async () => {
  const old = await agent(board, "admin"),
    next = await agent(board, "admin"),
    child = await agent(old.id),
    privateResource = await resource();
  await connect(child, privateResource);
  const s = await start(child),
    pending = await s.call("send_message", {
      kind: "result",
      target: { kind: "manager" },
      message: "old team result",
    });
  expect(pending.waiting).toBe("approval");
  await k.graph.submitMove({
    targetParentId: next.id,
    moves: [{ nodeId: child.id, x: 10, y: 10 }],
    idempotencyKey: key(),
  });
  await expect(approve(pending.value.requestId)).rejects.toMatchObject({
    code: "VERSION_CONFLICT",
  });
  expect(await incoming(old)).toHaveLength(0);
  expect(await incoming(next)).toHaveLength(0);
});

it.each(["other-canvas", "non-agent", "deleted"])(
  "C11 %s target cannot receive a message or leave a partial sender record",
  async (kind) => {
    const from = await agent(),
      s = await start(from);
    let to: Node;
    if (kind === "other-canvas") {
      const c = (await k.graph.createCanvas({ title: "other", idempotencyKey: key() })).node;
      to = await agent(c.id);
    } else if (kind === "non-agent") to = await resource();
    else {
      to = await agent();
      await k.graph.deleteNodes({ nodeIds: [to.id], idempotencyKey: key() });
    }
    expect(
      (
        await s.call("send_message", {
          kind: "update",
          target: { kind: "agent", agentId: to.id },
          message: "must not deliver",
        })
      ).result.isError,
    ).toBe(true);
    const history = await k.conversations.read.history(
      (await k.conversations.read.forAgent(from.id)).id,
    );
    expect(history.filter((m) => m.role === "message")).toHaveLength(0);
    expect(await incoming(to)).toHaveLength(0);
  },
);

it("C12 parallel sends and a replayed call retain all messages but activate the recipient once", async () => {
  const a = await agent(),
    b = await agent(),
    to = await agent();
  const left = await start(a),
    right = await start(b);
  const sent = Array.from({ length: 12 }, (_, i) => `parallel-${i}`);
  await Promise.all(
    sent.map((message, i) =>
      (i % 2 ? left : right).call(
        "send_message",
        { kind: "update", target: { kind: "agent", agentId: to.id }, message },
        message,
      ),
    ),
  );
  const args = { kind: "update", target: { kind: "agent", agentId: to.id }, message: "replay" };
  await Promise.all([
    left.call("send_message", args, "same"),
    left.call("send_message", args, "same"),
  ]);
  await k.maintain();
  expect(await runs(to)).toHaveLength(1);
  const messages = await incoming(to);
  expect(messages.map((m) => m.content.text).sort()).toEqual([...sent, "replay"].sort());
  expect(new Set(messages.map((m) => m.seq)).size).toBe(13);
  await consume(to, "replay");
  await k.maintain();
  expect(await runs(to)).toHaveLength(1);
});

it("C13 more than one inbox page is completely consumed without scheduling a second run", async () => {
  const from = await agent(),
    to = await agent(),
    s = await start(from);
  for (let i = 0; i < 105; i++)
    await s.call("send_message", {
      kind: "update",
      target: { kind: "agent", agentId: to.id },
      message: `page-message-${i}`,
    });
  await k.maintain();
  await consume(to, "page-message-104");
  const checkpoint = (
    await k.db.pool.query("select checkpoint from conversations where agent_id=$1", [to.id])
  ).rows[0].checkpoint;
  for (let i = 0; i < 105; i++) expect(JSON.stringify(checkpoint)).toContain(`page-message-${i}`);
  await k.maintain();
  expect(await runs(to)).toHaveLength(1);
});

it.each(["queued", "running", "message", "approval", "unknown"])(
  "C14 delivery to %s state resumes responsive waits and never duplicates a run",
  async (state) => {
    const from = await agent(),
      to = await agent(),
      s = await start(from);
    const submitted = await k.conversations.submit({
      canvasId: board,
      agentId: to.id,
      message: "existing work",
      key: key(),
    });
    if (state !== "queued") {
      const lease = (await k.runs.claim("existing"))!;
      expect(lease.id).toBe(submitted.run.id);
      if (state !== "running") await k.runs.finish(lease, "waiting", undefined, state);
    }
    expect(
      (
        await s.call("send_message", {
          kind: "update",
          target: { kind: "agent", agentId: to.id },
          message: "new work",
        })
      ).value.delivered,
    ).toBe(1);
    await k.maintain();
    const rows = await runs(to);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe(
      state === "message" || state === "approval" || state === "queued"
        ? "queued"
        : state === "running"
          ? "running"
          : "waiting",
    );
    expect((await incoming(to))[0].run_id).toBe(submitted.run.id);
  },
);

it("C15 late peer input at final completion is consumed by the existing run", async () => {
  const from = await agent(),
    to = await agent(),
    s = await start(from);
  await s.call("send_message", {
    kind: "update",
    target: { kind: "agent", agentId: to.id },
    message: "first",
  });
  await k.maintain();
  const finish = k.runs.finish.bind(k.runs);
  let injected = false;
  vi.spyOn(k.runs, "finish").mockImplementation(async (...args) => {
    if (!injected && args[1] === "succeeded") {
      injected = true;
      await s.call("send_message", {
        kind: "update",
        target: { kind: "agent", agentId: to.id },
        message: "late-input",
      });
    }
    return finish(...args);
  });
  await consume(to, "late-input");
  expect(injected).toBe(true);
  await k.maintain();
  expect(await runs(to)).toHaveLength(1);
});

it("C16 a full queue retains deliveries and wakes the recipient once capacity is freed", async () => {
  const from = await agent(),
    to = await agent(),
    s = await start(from);
  const settings = await k.runs.settings.read();
  await k.runs.settings.save(settings.revision, { ...settings.policy, pendingPerCanvas: 1 });
  await s.call("send_message", {
    kind: "update",
    target: { kind: "agent", agentId: to.id },
    message: "capacity",
  });
  await k.maintain();
  expect(await runs(to)).toHaveLength(0);
  expect((await incoming(to))[0].run_id).toBeNull();
  await k.runs.finish(s.run, "succeeded");
  await k.maintain();
  await consume(to, "capacity");
  await k.maintain();
  expect(await runs(to)).toHaveLength(1);
});

it("C17 two maintenance scans of the same inbox spend one activation, not two", async () => {
  const from = await agent(),
    to = await agent(),
    s = await start(from);
  await s.call("send_message", {
    kind: "update",
    target: { kind: "agent", agentId: to.id },
    message: "one activation",
  });
  await pausedCapture(() => k.maintain());
  expect(await runs(to)).toHaveLength(1);
  expect(
    (await k.db.pool.query("select activation_count from runs where id=$1", [s.run.id])).rows[0]
      .activation_count,
  ).toBe(1);
});

it("C18 stop between inbox scan and transaction must not create an empty run", async () => {
  const from = await agent(),
    to = await agent(),
    s = await start(from);
  await s.call("send_message", {
    kind: "update",
    target: { kind: "agent", agentId: to.id },
    message: "cancelled",
  });
  await pausedCapture(() => k.conversations.stop(to.id));
  expect(await runs(to)).toHaveLength(0);
});

it("C19 stop consumes old messages but permits a genuinely new authorized message", async () => {
  const from = await agent(),
    to = await agent(),
    s = await start(from);
  await s.call("send_message", {
    kind: "update",
    target: { kind: "agent", agentId: to.id },
    message: "old",
  });
  await k.conversations.stop(to.id);
  await k.maintain();
  expect(await runs(to)).toHaveLength(0);
  await s.call("send_message", {
    kind: "update",
    target: { kind: "agent", agentId: to.id },
    message: "new",
  });
  await k.maintain();
  await consume(to, "new");
  const inputs = requests.flatMap((r) =>
    r.messages.filter((m) => m.role === "user").map((m) => m.content),
  );
  expect(inputs.some((text) => text === "old")).toBe(false);
});

it("C20 failed recipient execution cannot reactivate forever from the same delivery", async () => {
  const from = await agent(),
    to = await agent(),
    s = await start(from);
  await s.call("send_message", {
    kind: "update",
    target: { kind: "agent", agentId: to.id },
    message: "fail once",
  });
  await k.maintain();
  const lease = (await k.runs.claim("failed"))!;
  expect(lease.frozen_input.agentId).toBe(to.id);
  await k.runs.fail(lease, new Error("controlled model failure"));
  await k.maintain();
  await k.maintain();
  expect(await runs(to)).toHaveLength(1);
  expect((await runs(to))[0].state).toBe("failed");
});

it("C21 limited causes do not discard independent deliveries in the same inbox", async () => {
  const a = await agent(),
    b = await agent(),
    to = await agent();
  const left = await start(a),
    right = await start(b);
  k.runs.limits.collaborationActivations = 1;
  await k.db.pool.query("update runs set activation_count=1 where id=$1", [left.run.id]);
  await left.call("send_message", {
    kind: "update",
    target: { kind: "agent", agentId: to.id },
    message: "exhausted",
  });
  await right.call("send_message", {
    kind: "update",
    target: { kind: "agent", agentId: to.id },
    message: "independent",
  });
  await k.maintain();
  await k.maintain();
  expect(await runs(to)).toHaveLength(1);
  expect(
    (await incoming(to)).find((m) => m.content.text === "independent").content.activationBlocked,
  ).toBeUndefined();
  await consume(to, "independent");
  expect(JSON.stringify(requests.flatMap((r) => r.messages))).not.toContain("exhausted");
});

it("C22 messages that resume waiting Agents remain subject to the collaboration budget", async () => {
  const from = await agent(),
    to = await agent(),
    s = await start(from),
    receiver = await start(to);
  await k.runs.finish(receiver.run, "waiting", undefined, "message");
  k.runs.limits.collaborationActivations = 1;
  await k.db.pool.query("update runs set activation_count=1 where id=$1", [s.run.id]);
  await s.call("send_message", {
    kind: "update",
    target: { kind: "agent", agentId: to.id },
    message: "over budget",
  });
  await k.maintain();
  expect((await k.runs.get(receiver.run.id)).state).toBe("waiting");
});

it("C23 model input distinguishes two same-text messages by their actual senders", async () => {
  const a = await agent(),
    b = await agent(),
    to = await agent();
  const left = await start(a),
    right = await start(b);
  await left.call("send_message", {
    kind: "update",
    target: { kind: "agent", agentId: to.id },
    message: "identical",
  });
  await right.call("send_message", {
    kind: "update",
    target: { kind: "agent", agentId: to.id },
    message: "identical",
  });
  await k.maintain();
  await consume(to, "identical");
  const modelInput = JSON.stringify(
    requests.flatMap((r) => r.messages.filter((m) => m.role === "user")),
  );
  expect(modelInput).toContain(a.id);
  expect(modelInput).toContain(b.id);
});

it("C24 a real model-tool journey recruits, delegates, waits, reports and finishes", async () => {
  const manager = await agent(board, "admin", true, "journey-manager"),
    s = await start(manager);
  let managerTurn = 0,
    childTurn = 0,
    hired = "";
  respond = ({ messages }) => {
    if (
      JSON.stringify(messages.filter((m) => ["system", "developer"].includes(m.role))).includes(
        "journey-manager",
      )
    ) {
      managerTurn++;
      if (managerTurn === 1)
        return {
          tool: "hire_agent",
          args: {
            task: "review-task-marker",
            persona: "journey-member",
            role: "write",
            respondToResources: true,
          },
        };
      if (managerTurn === 2) {
        hired = JSON.parse(messages.at(-1)!.content).id;
        return { tool: "wait_for_message", args: {} };
      }
      return { text: "manager-finished-marker" };
    }
    childTurn++;
    return childTurn === 1
      ? {
          tool: "send_message",
          args: {
            kind: "result",
            target: { kind: "request", id: JSON.parse(wireOutput(messages, "unused")).target.id },
            message: "review-result-marker",
          },
        }
      : { output: { target: { kind: "internal" }, message: "member-finished-marker" } };
  };
  await k.conversations.execute(s.ctx, (ctx, input) => k.tools.create(ctx, input));
  expect((await k.runs.get(s.run.id)).reason).toBe("message");
  const child = await k.graph.queries.node(hired);
  expect(child.managerId).toBe(manager.id);
  await k.maintain();
  await consume(child, "review-task-marker");
  await consume(manager, "review-result-marker");
  expect(managerTurn).toBe(3);
  expect(childTurn).toBe(2);
  expect(await incoming(manager)).toHaveLength(1);
  expect(await incoming(child)).toHaveLength(1);
});

it("C25 replay with altered arguments is rejected and cannot change a delivered message", async () => {
  const from = await agent(),
    to = await agent(),
    s = await start(from);
  await s.call(
    "send_message",
    { kind: "update", target: { kind: "agent", agentId: to.id }, message: "original" },
    "immutable",
  );
  await expect(
    s.call(
      "send_message",
      { kind: "update", target: { kind: "agent", agentId: to.id }, message: "replacement" },
      "immutable",
    ),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect((await incoming(to)).map((m) => m.content.text)).toEqual(["original"]);
});

it("C26 a stopped sender loses the authority to deliver a late tool call", async () => {
  const from = await agent(),
    to = await agent(),
    s = await start(from);
  await k.conversations.stop(from.id);
  await expect(
    s.call("send_message", {
      kind: "update",
      target: { kind: "agent", agentId: to.id },
      message: "too late",
    }),
  ).rejects.toMatchObject({ code: "STALE_EXECUTION" });
  expect(await incoming(to)).toHaveLength(0);
  expect(await runs(to)).toHaveLength(0);
});

it("C27 an invalid recipient model does not starve a healthy recipient or lose its message", async () => {
  const from = await agent(),
    broken = await agent(),
    healthy = await agent(),
    s = await start(from);
  await k.graph.updateNode(broken.id, {
    agent: { ...broken.agent!, model: { profileId: "deleted-fixture-profile" } },
    expectedRevision: broken.revision,
    idempotencyKey: key(),
  });
  for (const node of [broken, healthy])
    await s.call("send_message", {
      kind: "update",
      target: { kind: "agent", agentId: node.id },
      message: "not lost",
    });
  await k.maintain();
  expect(await runs(broken)).toHaveLength(0);
  expect((await incoming(broken))[0].run_id).toBeNull();
  await consume(healthy, "not lost");
  await k.graph.updateNode(broken.id, {
    agent: broken.agent!,
    expectedRevision: (await k.graph.queries.node(broken.id)).revision,
    idempotencyKey: key(),
  });
  await k.maintain();
  await consume(broken, "not lost");
});

it("C28 a delivery after stop waits for cancellation to settle, then starts one new run", async () => {
  const from = await agent(),
    to = await agent(),
    s = await start(from),
    target = await start(to);
  await s.call("send_message", {
    kind: "update",
    target: { kind: "agent", agentId: to.id },
    message: "old work",
  });
  await k.conversations.stop(to.id);
  await s.call("send_message", {
    kind: "update",
    target: { kind: "agent", agentId: to.id },
    message: "new work",
  });
  await k.maintain();
  expect(await runs(to)).toHaveLength(1);
  await k.runs.fail(target.run, new Error("cancellation acknowledged"));
  await k.maintain();
  await consume(to, "new work");
  expect((await runs(to)).map((r) => r.state).sort()).toEqual(["cancelled", "succeeded"]);
  const inputs = requests.flatMap((r) =>
    r.messages.filter((m) => m.role === "user").map((m) => m.content),
  );
  expect(inputs.some((text) => text === "old work")).toBe(false);
});

it("C29 a broadcast append failure rolls back every delivery and the sender's broadcast record", async () => {
  const from = await agent(),
    a = await agent(),
    b = await agent(),
    r = await resource(),
    s = await start(from);
  for (const node of [from, a, b]) await connect(node, r);
  const append = k.conversations.append.bind(k.conversations);
  let deliveries = 0;
  vi.spyOn(k.conversations, "append").mockImplementation(async (...args) => {
    if (args[3] === "message" && ++deliveries === 2)
      throw new Error("injected second delivery failure");
    return append(...args);
  });
  await expect(
    s.call("send_message", {
      kind: "update",
      target: { kind: "resource_readers", resourceIds: [r.id] },
      message: "atomic",
    }),
  ).rejects.toThrow("injected second delivery failure");
  expect(deliveries).toBe(2);
  for (const to of [a, b]) expect(await incoming(to)).toHaveLength(0);
  const c = await k.conversations.read.forAgent(from.id);
  expect(
    (await k.conversations.read.history(c.id)).filter((m) => m.role === "broadcast"),
  ).toHaveLength(0);
});

it("C30 self-messages stay in the current run, and forged recipient fields cannot add a target", async () => {
  const from = await agent(),
    unintended = await agent(),
    s = await start(from);
  const forged = await s.call("send_message", {
    kind: "update",
    target: { kind: "agent", agentId: from.id },
    recipients: [unintended.id],
    message: "self-note",
  });
  expect(forged.result.isError).toBe(true);
  expect(await incoming(from)).toHaveLength(0);
  expect(
    (
      await s.call("send_message", {
        kind: "update",
        target: { kind: "agent", agentId: from.id },
        message: "self-note",
      })
    ).value.recipients,
  ).toEqual([from.id]);
  expect(await incoming(unintended)).toHaveLength(0);
  expect((await incoming(from))[0].run_id).toBe(s.run.id);
  await k.maintain();
  expect(await runs(from)).toHaveLength(1);
  await consume(from, "self-note", s.run);
});

it("C31 a page of retryable model failures cannot starve a healthy recipient on the next page", async () => {
  const from = await agent(),
    s = await start(from);
  const targets = [];
  for (let i = 0; i < 129; i++) {
    const node = await agent();
    targets.push({ node, conversation: await k.conversations.read.forAgent(node.id) });
    await s.call("send_message", {
      kind: "update",
      target: { kind: "agent", agentId: node.id },
      message: "paged activation",
    });
  }
  // A fresh scanner and database ordering fix the page boundary independently
  // of random IDs, locale and the cursor left by earlier tests.
  const maintainer = new InboxScheduler(k.db, k.conversations);
  const ordered = (
    await k.db.pool.query("select id from conversations where id=any($1::text[]) order by id", [
      targets.map((t) => t.conversation.id),
    ])
  ).rows.map((r) => r.id);
  targets.sort((a, b) => ordered.indexOf(a.conversation.id) - ordered.indexOf(b.conversation.id));
  const capture = k.conversations.models.capture.bind(k.conversations.models);
  vi.spyOn(k.conversations.models, "capture").mockImplementation(async (selection) => {
    if (selection?.profileId === "temporarily-unavailable-profile")
      throw new Error("temporary model lookup failure");
    return capture(selection);
  });
  for (const { node } of targets.slice(0, 128))
    await k.graph.updateNode(node.id, {
      agent: { ...node.agent!, model: { profileId: "temporarily-unavailable-profile" } },
      expectedRevision: node.revision,
      idempotencyKey: key(),
    });
  for (let page = 0; page < 3; page++) await maintainer.maintain();
  const healthy = targets.at(-1)!.node;
  expect(await runs(healthy)).toHaveLength(1);
  await consume(healthy, "paged activation");
});

it("C32 concurrent recruitment reserves distinct positions and Stop drains old resource triggers", async () => {
  const manager = await agent(board, "admin"),
    s = await start(manager);
  const hires = await Promise.all(
    Array.from({ length: 4 }, () =>
      s.call("hire_agent", {
        task: "Check the assigned fixture.",
        persona: "fixture",
        role: "write",
        respondToResources: true,
      }),
    ),
  );
  const children = await Promise.all(hires.map((h) => k.graph.queries.node(h.value.id)));
  for (const [i, a] of children.entries())
    for (const b of children.slice(i + 1)) {
      const p = a.position,
        q = b.position;
      expect(
        p.x + p.width <= q.x ||
          q.x + q.width <= p.x ||
          p.y + p.height <= q.y ||
          q.y + q.height <= p.y,
      ).toBe(true);
    }
  const changed = children[0]!;
  await k.graph.updateNode(changed.id, {
    text: "changed evidence",
    expectedRevision: changed.revision,
    idempotencyKey: key(),
  });
  expect(
    (
      await k.db.pool.query(
        "select count(*)::int as n from schedules where agent_id=$1 and enabled and kind='resource_change'",
        [manager.id],
      )
    ).rows[0].n,
  ).toBe(1);
  await k.conversations.controlTeams([manager.id], "stop", key(), "en");
  await k.runs.fail(s.run, new Error("stopped"));
  await k.db.pool.query(
    "update schedules set next_due_at=now()-interval '1 second' where canvas_id=$1",
    [board],
  );
  await k.tools.tickSchedules();
  await k.maintain();
  expect(
    (await runs(manager)).filter((r) => ["queued", "running", "waiting"].includes(r.state)),
  ).toHaveLength(0);
});

it.each([true, false])(
  "C33 hire submits exactly one initial task with enabled=%s",
  async (enabled) => {
    const manager = await agent(board, "admin"),
      s = await start(manager);
    const args = {
      persona: "role only",
      task: "INITIAL_TASK",
      role: "read",
      respondToResources: enabled,
    };
    const first = await s.call("hire_agent", args, "atomic-hire");
    expect(first.value.initialTask).toMatchObject({ status: "pending", delivered: 1 });
    const child = await k.graph.queries.node(first.value.id);
    expect((await s.call("hire_agent", args, "atomic-hire")).value.id).toBe(child.id);
    expect(await incoming(child)).toHaveLength(1);
    expect((await incoming(child))[0].content).toMatchObject({
      text: "INITIAL_TASK",
      from: manager.id,
    });
    expect(
      (await k.graph.queries.snapshot(board)).edges.filter(
        (e) => e.from === child.id && e.to === manager.id && e.type === "derived_from",
      ),
    ).toHaveLength(1);
    expect(
      (await k.db.pool.query("select resource_id from grants where subject_id=$1", [child.id]))
        .rows,
    ).toHaveLength(0);
    await k.maintain();
    await consume(child, "INITIAL_TASK");
  },
);

it("C34 a missing initial task cannot silently create an idle hire", async () => {
  const manager = await agent(board, "admin"),
    s = await start(manager);
  const output = await s.call("hire_agent", {
    persona: "do work",
    role: "read",
    respondToResources: true,
  });
  expect(output.result.isError).toBe(true);
  expect((await k.graph.queries.node(manager.id)).childOrder).toHaveLength(0);
});

it("C35 status inspection is bounded, private and does not wake targets or consume their input", async () => {
  const observer = await agent(board, "read"),
    target = await agent(board, "admin", false, "PRIVATE_PROMPT_MARKER"),
    idle = await agent();
  const s = await start(observer),
    active = await start(target);
  await k.runs.finish(active.run, "waiting", undefined, "approval");
  const before = await k.conversations.read.forAgent(target.id);
  const query = await s.call("get_agent_status", { agentIds: [target.id, idle.id, target.id] });
  expect(query.value.agents).toHaveLength(2);
  expect(query.value.agents.find((a: any) => a.id === target.id)).toMatchObject({
    runState: "waiting",
    waitReason: "approval",
    runId: active.run.id,
    pendingMessages: 1,
  });
  expect(query.value.agents.find((a: any) => a.id === idle.id)).toMatchObject({
    runState: "idle",
    runId: null,
  });
  expect(JSON.stringify(query.value)).not.toMatch(
    /checkpoint|persona|INITIAL_TASK|PRIVATE_PROMPT_MARKER/,
  );
  const after = await k.conversations.read.forAgent(target.id);
  expect(after).toEqual(before);
  expect((await k.runs.get(active.run.id)).state).toBe("waiting");
  await k.db.pool.query("update runs set state='succeeded',reason=null where id=$1", [
    active.run.id,
  ]);
  expect(
    (await s.call("get_agent_status", { agentIds: [target.id] })).value.agents[0].runState,
  ).toBe("succeeded");
  const other = await k.graph.createCanvas({ title: "other", idempotencyKey: key() });
  const foreign = await agent(other.node.id);
  expect((await s.call("get_agent_status", { agentIds: [foreign.id] })).result.isError).toBe(true);
  expect(
    (await s.call("get_agent_status", { agentIds: Array.from({ length: 41 }, () => target.id) }))
      .result.isError,
  ).toBe(true);
  expect(await incoming(target)).toHaveLength(0);
});

it("C36 collaboration activity retains deleted identities and applies team and selection filters before pagination", async () => {
  const manager = await agent(board, "admin"),
    child = await agent(manager.id),
    peer = await agent(board, "admin"),
    unrelated = await agent(peer.id);
  const s = await start(manager),
    p = await start(peer);
  await s.call("send_message", {
    kind: "update",
    target: { kind: "agent", agentId: child.id },
    message: "team-message",
  });
  for (let i = 0; i < 101; i++) {
    const sent = await p.call("send_message", {
      kind: "update",
      target: { kind: "agent", agentId: unrelated.id },
      message: `unrelated-${i}`,
    });
    expect(sent.result.isError).not.toBe(true);
  }
  expect((await k.activity.board(board, false)).events).toHaveLength(100);
  const filtered = await app.inject({
    method: "GET",
    url: `/api/v2/canvas-activity?canvasId=${board}&groupId=${manager.id}`,
    headers: { authorization: `Bearer ${app.kernel.config.accessToken}` },
  });
  expect(filtered.statusCode).toBe(200);
  expect(filtered.json().events.map((e: any) => e.data.text)).toEqual(["team-message"]);
  const selected = await k.activity.board(board, false, { selection: [child.id] });
  expect(selected.events).toHaveLength(1);
  await k.graph.deleteNodes({ nodeIds: [manager.id], idempotencyKey: key() });
  const history = await k.activity.board(board, false, { selection: [child.id] });
  expect(history.events).toHaveLength(1);
  expect(history.events[0]).toMatchObject({
    agentId: manager.id,
    data: {
      senderId: manager.id,
      senderName: manager.title,
      recipientNames: { [child.id]: child.title },
    },
  });
});

it("C37 a failed initial-task append rolls back the member, grant and outgoing message together", async () => {
  const manager = await agent(board, "admin"),
    s = await start(manager);
  const before = await k.conversations.read.forAgent(manager.id);
  const append = k.conversations.append.bind(k.conversations);
  vi.spyOn(k.conversations, "append").mockImplementation(async (...args) => {
    const output = await append(...args);
    if (args[3] === "message" && (args[4] as any).from)
      throw new DomainError("VALIDATION", "fixture append failure");
    return output;
  });
  const response = await s.call("hire_agent", {
    persona: "",
    task: "FIRST",
    respondToResources: true,
    role: "read",
  });
  expect(response.result.isError).toBe(true);
  expect((await k.graph.queries.node(manager.id)).childOrder).toHaveLength(0);
  expect((await k.conversations.read.forAgent(manager.id)).message_seq).toBe(before.message_seq);
  expect(
    (await k.db.pool.query("select * from grants where subject_id=$1", [manager.id])).rows,
  ).toHaveLength(0);
});

it("C38 a full run queue retains the hire task and admits it when capacity returns", async () => {
  const manager = await agent(board, "admin"),
    s = await start(manager);
  const settings = await k.runs.settings.read();
  await k.runs.settings.save(settings.revision, { ...settings.policy, pendingPerCanvas: 1 });
  const hired = await s.call("hire_agent", {
    persona: "",
    task: "WAIT_FOR_CAPACITY",
    respondToResources: false,
    role: "read",
  });
  const child = await k.graph.queries.node(hired.value.id);
  await k.maintain();
  expect(await runs(child)).toHaveLength(0);
  expect(
    (await s.call("get_agent_status", { agentIds: [child.id] })).value.agents[0],
  ).toMatchObject({ runState: "idle", pendingMessages: 1 });
  await k.runs.finish(s.run, "succeeded");
  await k.maintain();
  await consume(child, "WAIT_FOR_CAPACITY");
});

it("C39 workspace recruitment submits the task once and labels the workspace sender", async () => {
  const submission = await k.conversations.submit({ canvasId: board, message: "hire", key: key() });
  const run = (await k.runs.claim("owner-hire"))!;
  const ctx = context(run),
    tools = await k.tools.create(ctx, run.frozen_input);
  const hire = tools.find((t) => t.name === "hire_agent")!;
  const args = {
    persona: "",
    task: "WORKSPACE_TASK",
    role: "read",
    respondToResources: false,
  };
  const response = await invokeTool(ctx, hire, "owner-hire", args);
  const output = JSON.parse((response.result.content[0] as any).text);
  await invokeTool(ctx, hire, "owner-hire", args);
  const child = await k.graph.queries.node(output.id);
  expect((await incoming(child))[0].content).toMatchObject({
    from: "workspace",
    text: "WORKSPACE_TASK",
  });
  expect(await incoming(child)).toHaveLength(1);
  expect((await k.activity.board(board)).events[0]!.data.senderId).toBe("workspace");
  expect(run.id).toBe(submission.run.id);
  await k.maintain();
  await consume(child, "WORKSPACE_TASK");
});

it("C40 a steer submitted just after completion persists once and starts the next run", async () => {
  const first = await k.conversations.submit({ canvasId: board, message: "original", key: key() });
  const original = (await k.runs.claim("steer-boundary"))!;
  await k.runs.finish(original, "succeeded");
  // A later chat can choose another profile without rewriting the session's
  // original selection. Continue with the most recent run's model.
  await k.db.pool.query("update conversations set model=$2 where id=$1", [
    first.conversationId,
    JSON.stringify({ profileId: "deleted-earlier-profile" }),
  ]);
  const payload = {
    sessionId: first.conversationId,
    message: "AFTER_COMPLETION",
    idempotencyKey: key(),
  };
  const post = () =>
    app.inject({
      method: "POST",
      url: "/api/v2/agent/steer",
      headers: { authorization: `Bearer ${k.config.accessToken}` },
      payload,
    });
  const response = await post();
  expect(response.statusCode).toBe(200);
  expect(response.json().queued).toBe(true);
  expect((await post()).json()).toEqual(response.json());
  const queued = (
    await k.db.pool.query("select id,state from runs where subject_id=$1 order by created_at", [
      first.conversationId,
    ])
  ).rows;
  expect(queued.map((r) => r.state)).toEqual(["succeeded", "queued"]);
  expect(
    (
      await k.db.pool.query(
        "select seq from messages where conversation_id=$1 and content->>'text'=$2",
        [first.conversationId, payload.message],
      )
    ).rows,
  ).toHaveLength(1);
});

it("C41 admins send across teams and resource scopes without granting resource access", async () => {
  const sender = await agent(board, "admin"),
    otherTeam = await agent(board, "admin"),
    recipients = await Promise.all(
      (["read", "write", "admin"] as const).map((role) => agent(otherTeam.id, role, false)),
    ),
    hidden = await resource();
  await connect(recipients[1]!, hidden);
  const s = await start(sender);
  const before = (
    await k.db.pool.query("select * from grants where canvas_id=$1 order by id", [board])
  ).rows;
  for (const recipient of recipients) {
    const sent = await s.call("send_message", {
      kind: "update",
      target: { kind: "agent", agentId: recipient.id },
      message: key(),
    });
    expect(sent.value.delivered).toBe(1);
    expect(sent.waiting).toBeUndefined();
  }
  const args = {
    kind: "update",
    target: {
      kind: "agents",
      agentIds: [sender.id, ...recipients.map((r) => r.id), recipients[0]!.id],
    },
    message: key(),
  };
  const broadcast = await s.call("send_message", args);
  expect(broadcast.value.recipients).toEqual(recipients.map((r) => r.id).sort());
  expect((await s.call("send_message", args, broadcast.logical)).value).toEqual(broadcast.value);
  for (const recipient of recipients) expect(await incoming(recipient)).toHaveLength(2);
  expect(await incoming(sender)).toHaveLength(0);
  const all = await s.call("send_message", {
    kind: "update",
    target: { kind: "canvas" },
    message: key(),
  });
  expect(all.value.recipients).toEqual([otherTeam.id, ...recipients.map((r) => r.id)].sort());
  expect((await k.access.list(board, { status: "pending" })).total).toBe(0);
  expect(
    (await k.db.pool.query("select * from grants where canvas_id=$1 order by id", [board])).rows,
  ).toEqual(before);
  expect((await s.call("read", { target: { kind: "node", nodeId: hidden.id } })).waiting).toBe(
    "approval",
  );
});

it.each(["read", "write"] as const)(
  "C42 %s senders retain scope checks and cannot use administrator broadcast targets",
  async (role) => {
    const sender = await agent(board, role),
      target = await agent(board, "write"),
      secret = await resource();
    await connect(target, secret);
    const s = await start(sender);
    for (const audience of [{ kind: "agents", agentIds: [target.id] }, { kind: "canvas" }]) {
      expect(
        (await s.call("send_message", { kind: "update", target: audience, message: key() })).result
          .isError,
      ).toBe(true);
    }
    expect(
      (
        await s.call("send_message", {
          kind: "update",
          target: { kind: "agent", agentId: target.id },
          message: key(),
        })
      ).waiting,
    ).toBe("approval");
    expect(await incoming(target)).toHaveLength(0);
  },
);

async function freezeSend(s: Awaited<ReturnType<typeof start>>, args: object) {
  const logical = key(),
    callId = key();
  const _tool = s.tools.find((t) => t.name === "send_message")!;
  const frozen = args;
  await k.db.canvas(board, async (tx) => {
    const dispatchId = key();
    const intent = await resolveTarget(
      tx,
      {
        canvasId: board,
        conversationId: s.run.subject_id,
        agentId: s.run.frozen_input.agentId,
        causeId: s.run.cause_id,
        dispatchId,
      },
      args as any,
    );
    await tx.query(
      `insert into message_dispatches(id,canvas_id,conversation_id,run_id,logical_id,input_hash,origin,generation,payload,intent)
      values($1,$2,$3,$4,$5,$6,'tool',0,$7,$8)`,
      [
        dispatchId,
        board,
        s.run.subject_id,
        s.run.id,
        `tool:${s.run.id}:${logical}`,
        digest(args),
        JSON.stringify(args),
        JSON.stringify(intent),
      ],
    );
  });
  await k.db.pool.query(
    "insert into tool_calls(id,run_id,attempt_id,logical_call_id,name,args,args_hash,execution_input,effect_class,state) values($1,$2,$3,$4,'send_message',$5,$6,$7,'graph','prepared')",
    [
      callId,
      s.run.id,
      s.run.attemptId,
      logical,
      JSON.stringify(args),
      digest(args),
      JSON.stringify(frozen),
    ],
  );
  return logical;
}

it("C43 broadcasts retain the frozen audience during recovery and reject removed targets atomically", async () => {
  const sender = await agent(board, "admin"),
    first = await agent(),
    second = await agent(),
    s = await start(sender);
  const args = { kind: "update", target: { kind: "canvas" }, message: key() };
  const logical = await freezeSend(s, args);
  const late = await agent();
  expect((await s.call("send_message", args, logical)).value.recipients).toEqual(
    [first.id, second.id].sort(),
  );
  expect(await incoming(late)).toHaveLength(0);
  const stale = {
    kind: "update",
    target: { kind: "agents", agentIds: [first.id, second.id] },
    message: key(),
  };
  const staleLogical = await freezeSend(s, stale);
  await k.graph.deleteNodes({ nodeIds: [second.id], idempotencyKey: key() });
  expect((await s.call("send_message", stale, staleLogical)).result.isError).toBe(true);
  expect(await incoming(first)).toHaveLength(1);
  const foreignBoard = (await k.graph.createCanvas({ title: key(), idempotencyKey: key() })).node;
  const foreign = await agent(foreignBoard.id);
  expect(
    (
      await s.call("send_message", {
        kind: "update",
        target: { kind: "agents", agentIds: [first.id, foreign.id] },
        message: key(),
      })
    ).result.isError,
  ).toBe(true);
  expect(await incoming(first)).toHaveLength(1);
  expect(await incoming(foreign)).toHaveLength(0);
  const demoted = { kind: "update", target: { kind: "canvas" }, message: key() };
  const beforeDemotion = await freezeSend(s, demoted);
  await k.db.pool.query(
    "update agent_configs set config=jsonb_set(config,'{role}','\"write\"') where node_id=$1",
    [sender.id],
  );
  expect((await s.call("send_message", demoted, beforeDemotion)).result.isError).toBe(true);
  expect((await s.call("send_message", args, logical)).value.delivered).toBe(2);
  expect(await incoming(first)).toHaveLength(1);
});

it("C44 empty canvas broadcasts do not activate any conversation", async () => {
  const sender = await agent(board, "admin"),
    s = await start(sender);
  for (const target of [{ kind: "canvas" }, { kind: "agents", agentIds: [sender.id, sender.id] }])
    expect(
      (await s.call("send_message", { kind: "update", target, message: key() })).value,
    ).toMatchObject({
      delivered: 0,
      recipients: [],
    });
  expect(await incoming(sender)).toHaveLength(0);
  expect(
    (await k.db.pool.query("select count(*)::int as n from runs where canvas_id=$1", [board]))
      .rows[0].n,
  ).toBe(1);
});

it("resource-reader broadcasts require an explicit resource filter", async () => {
  const sender = await agent(board, "admin"),
    target = await agent(),
    s = await start(sender);
  expect(
    (
      await s.call("send_message", {
        target: { kind: "resource_readers" },
        kind: "update",
        message: "invalid",
      })
    ).result.isError,
  ).toBe(true);
  expect(await incoming(target)).toHaveLength(0);
});

it("C45 gaining admin authority resumes the original pending send instead of dropping it", async () => {
  const manager = await agent(board, "admin"),
    sender = await agent(manager.id, "write"),
    target = await agent(),
    secret = await resource();
  await connect(target, secret);
  const s = await start(sender),
    args = { kind: "update", target: { kind: "agent", agentId: target.id }, message: key() };
  const pending = await s.call("send_message", args);
  expect(pending.waiting).toBe("approval");
  await k.db.pool.query(
    "update agent_configs set config=jsonb_set(config,'{role}','\"admin\"') where node_id=$1",
    [sender.id],
  );
  await k.maintain();
  expect(
    (await k.db.pool.query("select status from approvals where id=$1", [pending.value.requestId]))
      .rows[0].status,
  ).toBe("satisfied");
  expect(
    (
      await k.db.pool.query("select state from tool_calls where run_id=$1 and logical_call_id=$2", [
        s.run.id,
        pending.logical,
      ])
    ).rows[0].state,
  ).toBe("prepared");
  expect(await incoming(target)).toHaveLength(0);
  expect((await s.call("send_message", args, pending.logical)).value.delivered).toBe(1);
  await s.call("send_message", args, pending.logical);
  expect(await incoming(target)).toHaveLength(1);
});

it.each(["denied", "expired", "escalated"])(
  "C46 admin authority does not replay a %s send",
  async (state) => {
    const manager = await agent(board, "admin"),
      sender = await agent(manager.id, "write"),
      target = await agent(),
      secret = await resource();
    await connect(target, secret);
    const s = await start(sender),
      args = { kind: "update", target: { kind: "agent", agentId: target.id }, message: key() };
    const pending = await s.call("send_message", args);
    if (state === "denied") await approve(pending.value.requestId, "deny");
    if (state === "expired")
      await k.db.pool.query(
        "update approvals set expires_at=now()-interval '1 second' where id=$1",
        [pending.value.requestId],
      );
    if (state === "escalated")
      await k.access.decide(pending.value.requestId, 1, "escalate", "explicit user review");
    await k.db.pool.query(
      "update agent_configs set config=jsonb_set(config,'{role}','\"admin\"') where node_id=$1",
      [sender.id],
    );
    await k.maintain();
    expect(
      (await k.db.pool.query("select status from approvals where id=$1", [pending.value.requestId]))
        .rows[0].status,
    ).not.toBe("satisfied");
    expect(await incoming(target)).toHaveLength(0);
  },
);
