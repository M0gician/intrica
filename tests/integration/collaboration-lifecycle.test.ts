import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRole } from "@intrica/contracts";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { invokeTool } from "../../apps/server/dist/modules/execution/tool-calls.js";
import { completionState } from "../../apps/server/dist/modules/work/messaging/completion.js";

const key = (): string => randomUUID();
const database = `intrica_lifecycle_${key().replaceAll("-", "")}`;
let app: Awaited<ReturnType<typeof buildServer>>, k: Kernel, admin: pg.Client;
let directory: string, board: string;
const position = { x: 0, y: 0, width: 220, height: 300 };
beforeAll(async () => {
  const url = new URL(process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres");
  admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  await admin.query(`create database ${database}`);
  url.pathname = `/${database}`;
  directory = await realpath(await mkdtemp(join(tmpdir(), "intrica-lifecycle-")));
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
  board = (await k.graph.createCanvas({ title: "Tool contracts", idempotencyKey: key() })).node.id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await k.db.pool.query("update message_deliveries set state='cancelled' where state='open'");
  await k.db.pool.query("update approvals set status='cancelled' where status='pending'");
  await k.db.pool.query(
    "update tool_calls set state='failed',delivered_at=now() where state not in ('succeeded','failed')",
  );
  await k.db.pool.query(
    "update runs set state='cancelled' where state in ('queued','running','waiting')",
  );
  await k.db.pool.query("update schedules set enabled=false");
  await k.db.pool.query("update conversations set consumed_message_seq=message_seq");
});
afterAll(async () => {
  await app?.close();
  await admin.query(`drop database if exists ${database} with(force)`);
  await admin.end();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function agent(parentId = board, enabled = false, role: AgentRole = "write") {
  return (
    await k.graph.createNode({
      kind: "agent",
      title: "Member",
      parentId,
      position,
      agent: { role, persona: "", enabled },
      idempotencyKey: key(),
    })
  ).node;
}
async function start(agentId?: string) {
  await k.conversations.submit({
    canvasId: board,
    ...(agentId ? { agentId } : {}),
    message: "Contract verification",
    key: key(),
  });
  const run = (await k.runs.claim("contracts"))!;
  const ctx = { run, store: k.runs, signal: new AbortController().signal, progress() {} };
  const tools = await k.tools.create(ctx, run.frozen_input);
  return {
    run,
    ctx,
    tools,
    async call(name: string, args: object, logical = key()) {
      const t = tools.find((t) => t.name === name) ?? name;
      const response = await invokeTool(ctx, t, logical, args);
      const text = (response.result.content[0] as { text: string }).text;
      let value: any;
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
      return { ...response, value, logical };
    },
  };
}

async function review(s: Awaited<ReturnType<typeof start>>) {
  const inbox = (await s.call("review_inbox", { action: "inspect" })).value;
  return s.call("review_inbox", {
    action: "confirm",
    reviewId: inbox.reviewId,
    decisions: inbox.items.map((item: any) => ({
      itemId: item.id,
      action: item.kind === "message" ? "handled" : "wait",
    })),
  });
}
async function consume(s: Awaited<ReturnType<typeof start>>) {
  await k.db.pool.query("update conversations set consumed_message_seq=message_seq where id=$1", [
    s.run.subject_id,
  ]);
  await k.db.pool.query(
    "update messages set consumed_at=now(),consumed_run_id=$2 where conversation_id=$1 and consumed_run_id is null",
    [s.run.subject_id, s.run.id],
  );
}
async function _expire(requestId: string) {
  await k.db.pool.query(
    "update message_deliveries set snoozed_until=null,deadline_at=now()-interval '1 second' where id=$1",
    [requestId],
  );
}
async function notices(conversationId: string) {
  return (
    await k.db.pool.query(
      "select * from messages where conversation_id=$1 and role='message_notice' order by seq",
      [conversationId],
    )
  ).rows;
}

it("wakes a normally finished sender for unread FYI without a reply expectation and deduplicates across workers", async () => {
  const a = await agent(),
    b = await agent(),
    sender = await start(a.id);
  const delivered = (
    await sender.call("send_message", { to: "agent", id: b.id, message: "unread-fyi" })
  ).value.deliveries[0].id;
  await consume(sender);
  await k.runs.finish(sender.run, "succeeded");
  await k.db.pool.query(
    "update message_deliveries set unread_deadline_at=now()-interval '1 second' where id=$1",
    [delivered],
  );
  await Promise.all([k.tools.messages.tick(), k.tools.messages.tick()]);
  expect(await notices(sender.run.subject_id)).toHaveLength(1);
  expect((await notices(sender.run.subject_id))[0].content.deliveries[0]).toMatchObject({
    event: "unread",
    deliveryId: delivered,
    expectReply: false,
  });
  const resumed = (
    await k.db.pool.query(
      "select state from runs where subject_id=$1 order by created_at desc limit 1",
      [sender.run.subject_id],
    )
  ).rows[0];
  expect(resumed.state).toBe("queued");
  await k.tools.messages.tick();
  expect(await notices(sender.run.subject_id)).toHaveLength(1);
});

it("projects individual read and expedite receipts consistently in both inboxes and the canvas feed", async () => {
  const manager = await agent(board, false, "admin"),
    a = await agent(manager.id),
    b = await agent(manager.id),
    c = await agent(manager.id);
  const sender = await start(a.id),
    recipient = await start(b.id);
  const sent = (
    await sender.call("send_message", {
      to: "agents",
      ids: [b.id, c.id],
      message: "receipt-marker",
    })
  ).value;
  const d = sent.deliveries.find((q: any) => q.recipientId === b.id).id;
  const readSent = async () =>
    (await k.conversations.read.feed(a.id)).events.find(
      (e: any) => e.data.text === "receipt-marker",
    )!;
  const before = await readSent();
  expect(before.data.deliveryReceipts.map((r: any) => r.state)).toEqual(["unread", "unread"]);
  await sender.call("update_message", { deliveryId: d, action: "expedite" });
  await consume(recipient);
  const after = await readSent();
  expect(after.recordVersion).not.toBe(before.recordVersion);
  expect(after.data.deliveryReceipts.find((r: any) => r.recipientId === b.id)).toMatchObject({
    state: "read",
    priority: "expedited",
    tracking: false,
  });
  expect(after.data.deliveryReceipts.find((r: any) => r.recipientId === c.id).state).toBe("unread");
  const incoming = (await k.conversations.read.feed(b.id)).events.find(
    (e: any) => e.data.text === "receipt-marker",
  )!;
  expect(incoming.data.deliveryReceipts[0]).toMatchObject({
    deliveryId: d,
    state: "read",
    priority: "expedited",
  });
  const publicEvent = (await k.activity.board(board)).events.find(
    (e: any) => e.data.text === "receipt-marker",
  )!;
  expect(publicEvent.data.deliveryReceipts).toEqual(after.data.deliveryReceipts);
  await k.db.pool.query(
    "update message_deliveries set unread_deadline_at=now()-interval '1 second',snoozed_until=null where id=$1",
    [d],
  );
  await k.tools.messages.tick();
  expect(await notices(sender.run.subject_id)).toHaveLength(0);
});

it("coalesces coincident unread and reply deadlines and preserves the original deadline on wait", async () => {
  const a = await agent(),
    s = await start();
  const d = (
    await s.call("send_message", { to: "agent", id: a.id, message: "deadline", expectReply: true })
  ).value.deliveries[0].id;
  await k.db.pool.query(
    "update message_deliveries set unread_deadline_at=now()-interval '1 second',deadline_at=now()-interval '1 second' where id=$1",
    [d],
  );
  await k.tools.messages.tick();
  const notice = await notices(s.run.subject_id);
  expect(notice).toHaveLength(1);
  expect(notice[0].content.deliveries[0].event).toBe("reply_overdue");
  const original = (await k.tools.messages.status(d))!.deadlineAt;
  await s.call("update_message", { deliveryId: d, action: "wait", waitSeconds: 600 });
  expect((await k.tools.messages.status(d))!.deadlineAt).toEqual(original);
  await k.tools.messages.tick();
  expect(await notices(s.run.subject_id)).toHaveLength(1);
});

it("keeps HTTP tracing IDs out of review decisions and rejects incomplete confirmations explicitly", async () => {
  const s = await start();
  await k.db.canvas(board, (tx) =>
    k.conversations.append(
      tx,
      s.run.subject_id,
      key(),
      "user",
      { text: "owner-input", traceId: "http-trace-only" },
      s.run.id,
    ),
  );
  const inbox = (await s.call("review_inbox", { action: "inspect" })).value;
  expect(JSON.stringify(inbox)).not.toContain("http-trace-only");
  expect(inbox.incoming).toEqual([]);
  expect(inbox.outgoing).toEqual([]);
  const incomplete = await s.call("review_inbox", { action: "confirm", reviewId: inbox.reviewId });
  expect(incomplete.value.error).toMatchObject({
    code: "TOOL_ARGUMENTS",
    issues: expect.arrayContaining([expect.objectContaining({ path: "/decisions" })]),
  });
  expect(incomplete.value.reviewToken).toBeUndefined();
  expect((await review(s)).value.reviewToken).toBeTruthy();
});

it("requires explicit review before natural completion and bounds ignored completion hooks", async () => {
  const a = await agent(),
    s = await start();
  await s.call("send_message", {
    to: "agent",
    id: a.id,
    message: "pending-before-finish",
    expectReply: true,
  });
  await k.conversations.execute(s.ctx, (ctx, input) => k.tools.create(ctx, input));
  expect(await k.runs.get(s.run.id)).toMatchObject({ state: "waiting", reason: "inbox_review" });
  expect(
    (
      await k.db.pool.query(
        "select 1 from messages where conversation_id=$1 and role='completion_review'",
        [s.run.subject_id],
      )
    ).rowCount,
  ).toBe(2);
  expect(
    (
      await k.db.pool.query("select 1 from message_deliveries where sender_conversation_id=$1", [
        s.run.subject_id,
      ])
    ).rowCount,
  ).toBe(1);
});

it("lets reviewed informational messages remain monitored after completion but keeps dependencies waiting", async () => {
  const a = await agent(),
    s = await start();
  await s.call("send_message", { to: "agent", id: a.id, message: "information" });
  await consume(s);
  const inbox = (await s.call("review_inbox", { action: "inspect" })).value;
  const decisions = inbox.items.map((item: any) => ({
    itemId: item.id,
    action: item.kind === "message" ? "handled" : "background",
    reason: "The deliverable is complete; this is optional information.",
  }));
  const confirmed = await s.call("review_inbox", {
    action: "confirm",
    reviewId: inbox.reviewId,
    decisions,
  });
  expect(confirmed.value.completion).toBe("ready");
  expect((await completionState(k.db.pool, s.run.subject_id, s.run.id)).kind).toBe("ready");
  await k.conversations.execute(s.ctx, (ctx, input) => k.tools.create(ctx, input));
  expect((await k.runs.get(s.run.id)).state).toBe("succeeded");
  const other = await start();
  await other.call("send_message", {
    to: "agent",
    id: a.id,
    message: "required",
    expectReply: true,
  });
  await consume(other);
  await review(other);
  await k.conversations.execute(other.ctx, (ctx, input) => k.tools.create(ctx, input));
  expect(await k.runs.get(other.run.id)).toMatchObject({ state: "waiting", reason: "message" });
});

it("persists pause without consuming unread messages and resumes only on explicit input", async () => {
  const a = await agent(),
    b = await agent(),
    s = await start(a.id);
  await k.conversations.stop(b.id);
  const d = (
    await s.call("send_message", { to: "agent", id: b.id, message: "retained-while-paused" })
  ).value.deliveries[0].id;
  await k.access.maintain();
  const c = await k.conversations.read.forAgent(b.id);
  expect((await k.db.pool.query("select 1 from runs where subject_id=$1", [c.id])).rowCount).toBe(
    0,
  );
  expect((await k.tools.messages.status(d))!).toMatchObject({
    paused: true,
    readAt: null,
    pending: true,
  });
  await k.conversations.submit({ canvasId: board, agentId: b.id, message: "resume", key: key() });
  expect((await k.tools.messages.status(d))!.paused).toBe(false);
  const original = (
    await k.db.pool.query(
      "select run_id,consumed_run_id from messages where conversation_id=$1 and content->>'text'='retained-while-paused'",
      [c.id],
    )
  ).rows[0];
  expect(original.run_id).toBeTruthy();
  expect(original.consumed_run_id).toBeNull();
});

it("records unread notices while the sender is paused without reviving the sender", async () => {
  const a = await agent(),
    b = await agent(),
    s = await start(a.id);
  const d = (await s.call("send_message", { to: "agent", id: b.id, message: "pause-followup" }))
    .value.deliveries[0].id;
  await consume(s);
  await k.runs.finish(s.run, "succeeded");
  await k.conversations.stop(a.id);
  await k.db.pool.query(
    "update message_deliveries set unread_deadline_at=now()-interval '1 second' where id=$1",
    [d],
  );
  await k.tools.messages.tick();
  await k.access.maintain();
  expect(await notices(s.run.subject_id)).toHaveLength(1);
  expect(
    (
      await k.db.pool.query(
        "select state from runs where subject_id=$1 order by created_at desc limit 1",
        [s.run.subject_id],
      )
    ).rows[0].state,
  ).toBe("succeeded");
});

it("enables resource collaboration by default and inherits it during hiring without a required switch", async () => {
  const root = (
    await k.graph.createNode({ kind: "agent", parentId: board, position, idempotencyKey: key() })
  ).node;
  expect(root.agent!.enabled).toBe(true);
  const manager = await agent(board, true, "admin"),
    s = await start(manager.id);
  const hired = await s.call("hire_agent", {
    persona: "reviewer",
    task: "review this",
    role: "read",
  });
  expect(hired.result.isError).not.toBe(true);
  expect((await k.graph.queries.node(hired.value.id)).agent!.enabled).toBe(true);
  expect(
    (
      await k.db.pool.query("select count(*) from message_deliveries where recipient_agent_id=$1", [
        hired.value.id,
      ])
    ).rows[0].count,
  ).toBe("1");
});

it("reads a published GIF frame and metadata from its immutable bytes after its source changes", async () => {
  const maker = await agent(),
    auditor = await agent(),
    s = await start(maker.id);
  const path = join(await k.host.workspace(board, maker.id), "version.gif");
  const bytes = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  await writeFile(path, bytes);
  const created = await s.call("create_artifact", { kind: "text", title: "GIF version", path });
  expect(created.result.isError).not.toBe(true);
  await k.graph.createLink({ fromId: auditor.id, toId: created.value.id, idempotencyKey: key() });
  await writeFile(path, "changed source");
  const reader = await start(auditor.id);
  const metadata = await reader.call("read", {
    target: { kind: "node", nodeId: created.value.id },
    mode: "text",
  });
  expect(metadata.value).toMatchObject({
    format: "gif",
    frames: 1,
    hash: created.value.attachment.snapshot.hash,
    bytes: bytes.length,
  });
  expect(metadata.value.resource.path).toBeUndefined();
  expect(metadata.value.resource.sourcePath).toBe(path);
  const image = await reader.call("read", {
    target: { kind: "node", nodeId: created.value.id },
    frame: 0,
    mode: "image",
  });
  expect(image.result.content.some((p) => p.type === "image")).toBe(true);
  const scope = await k.host.scope({ agentId: auditor.id });
  expect(scope.roots.some((r) => r.path === path)).toBe(false);
});

it("reports only the selected read branch and gives a valid repair for file permission combinations", async () => {
  const a = await agent(),
    s = await start(a.id);
  const bad = await s.call("read", {
    target: { kind: "path", path: "x.gif", frame: 0 },
    mode: "image",
  });
  expect(bad.value.error.issues.map((e: any) => e.path)).toEqual(["/target/frame"]);
  const permission = await s.call("request_permission", {
    scope: { kind: "path", path: "/tmp/a.gif", access: "file", execution: "isolated" },
    reason: "decode",
  });
  expect(permission.value.executed).toBe(false);
  expect(permission.value.error.nextAction).toContain("execution=none");
  expect(permission.value.error.issues.every((e: any) => e.path === "/scope/execution")).toBe(true);
});

it("coalesces broadcast unread deadlines into one durable sender notice", async () => {
  const a = await agent(),
    b = await agent(),
    s = await start();
  const sent = (
    await s.call("send_message", { to: "agents", ids: [a.id, b.id], message: "broadcast-fyi" })
  ).value;
  await k.db.pool.query(
    "update message_deliveries set unread_deadline_at=now()-interval '1 second' where id=any($1::text[])",
    [sent.deliveries.map((d: any) => d.id)],
  );
  await Promise.all([k.tools.messages.tick(), k.tools.messages.tick()]);
  const reminders = await notices(s.run.subject_id);
  expect(reminders).toHaveLength(1);
  expect(reminders[0].content.deliveries).toHaveLength(2);
  const states = await k.tools.messages.statuses(sent.deliveries.map((d: any) => d.id));
  expect(states.every((d) => d.notice_count === 1)).toBe(true);
});

it("returns each delivery once when a status batch contains messages in both directions", async () => {
  const a = await agent(),
    b = await agent();
  const first = await start(a.id),
    second = await start(b.id);
  const outgoing = (
    await first.call("send_message", { to: "agent", id: b.id, message: "first direction" })
  ).value.deliveries[0].id;
  const incoming = (
    await second.call("send_message", { to: "agent", id: a.id, message: "return direction" })
  ).value.deliveries[0].id;
  const states = await k.tools.messages.statuses([outgoing, incoming, outgoing]);
  expect(states.map((d) => d.deliveryId).sort()).toEqual([outgoing, incoming].sort());
});

it("batches changed resource IDs and bounds the stability window", async () => {
  const a = await agent(board, true);
  const resources = [];
  for (let i = 0; i < 2; i++) {
    const node = (
      await k.graph.createNode({
        kind: "text",
        parentId: board,
        title: `resource-${i}`,
        text: "initial",
        position,
        idempotencyKey: key(),
      })
    ).node;
    await k.graph.createLink({ fromId: a.id, toId: node.id, idempotencyKey: key() });
    resources.push(node);
  }
  await k.graph.updateNode(resources[0]!.id, {
    text: "first change",
    expectedRevision: resources[0]!.revision,
    idempotencyKey: key(),
  });
  await k.db.pool.query(
    "update schedules set spec=spec||jsonb_build_object('firstChangeAt',clock_timestamp()-interval '25 seconds') where agent_id=$1 and kind='resource_change'",
    [a.id],
  );
  await k.graph.updateNode(resources[1]!.id, {
    text: "second change",
    expectedRevision: resources[1]!.revision,
    idempotencyKey: key(),
  });
  const schedule = (
    await k.db.pool.query(
      "select spec,extract(epoch from next_due_at-clock_timestamp()) as remaining from schedules where agent_id=$1 and kind='resource_change'",
      [a.id],
    )
  ).rows[0];
  expect(Number(schedule.remaining)).toBeLessThanOrEqual(5);
  expect(schedule.spec.resourceIds.sort()).toEqual(resources.map((r) => r.id).sort());
});
