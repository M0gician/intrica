import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRole } from "@intrica/contracts";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { invokeTool } from "../../apps/server/dist/modules/execution/tool-calls.js";
import { executeConversation } from "./helpers/execute-conversation.js";

const key = (): string => randomUUID();
const database = `intrica_message_hooks_${key().replaceAll("-", "")}`;
let app: Awaited<ReturnType<typeof buildServer>>, k: Kernel, admin: pg.Client;
let directory: string, board: string;
const position = { x: 0, y: 0, width: 220, height: 300 };
beforeAll(async () => {
  const url = new URL(process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres");
  admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  await admin.query(`create database ${database}`);
  url.pathname = `/${database}`;
  directory = await realpath(await mkdtemp(join(tmpdir(), "intrica-message-hooks-")));
  app = await buildServer({
    databaseUrl: url.href,
    dataDir: directory,
    accessToken: key(),
    worker: false,
    model: { kind: "mock", streamDelayMs: 0, supportsVision: false },
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
  await consume(s);
  const inbox = (await s.call("read_inbox", {})).value;
  const dependencies = inbox.items.filter((i: any) => i.dependency).map((i: any) => i.id);
  return s.call(
    "review_progress",
    dependencies.length
      ? {
          outcome: "waiting",
          reason: "Await verification",
          remaining_work: "Deliver result",
          dependency_ids: dependencies,
        }
      : { outcome: "completed", reason: "The assigned results are verified and delivered" },
  );
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
async function expire(requestId: string) {
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

it("rejects retired and malformed tools with precise audited failures and no delivery", async () => {
  const s = await start();
  for (const [name, args, code] of [
    ["report_result", { message: "obsolete" }, "UNKNOWN_TOOL"],
    [
      "send_message",
      { target: JSON.stringify({ kind: "agent", agentId: "x" }), message: "private-body" },
      "TOOL_ARGUMENTS",
    ],
    ["send_message", { to: { kind: "agent" }, message: "private-body" }, "TOOL_ARGUMENTS"],
    ["send_message", { to: "agent", message: "private-body" }, "MESSAGE_INPUT"],
    [
      "send_message",
      { to: "team", message: "private-body", replyWithinSeconds: 2 },
      "MESSAGE_INPUT",
    ],
  ] as const) {
    const called = await s.call(name, args);
    expect(called.result.isError).toBe(true);
    expect(called.value.error.code).toBe(code);
    expect(called.value.call.effect).toBe("none");
    expect(JSON.stringify(called.value)).not.toContain("private-body");
    const row = (
      await k.db.pool.query(
        "select state,result,schema_version from tool_calls where run_id=$1 and logical_call_id=$2",
        [s.run.id, called.logical],
      )
    ).rows[0];
    expect(row.state).toBe("failed");
    expect(row.schema_version).toBe(6);
    expect(row.result).toEqual(called.result);
  }
  expect(
    (
      await k.db.pool.query("select 1 from messages where conversation_id=$1 and role='message'", [
        s.run.subject_id,
      ])
    ).rowCount,
  ).toBe(0);
});

it("makes siblings with different resource grants visible and directly reachable without granting file access", async () => {
  const adminNode = await agent(board, false, "admin"),
    left = await agent(adminNode.id),
    right = await agent(adminNode.id);
  const resource = (
    await k.graph.createNode({
      kind: "text",
      parentId: board,
      title: "private",
      text: "private",
      position,
      idempotencyKey: key(),
    })
  ).node;
  await k.graph.createLink({ fromId: right.id, toId: resource.id, idempotencyKey: key() });
  const s = await start(left.id);
  const visible = (await s.call("list_agents", {})).value.agents;
  expect(visible.map((a: any) => a.id)).toEqual(
    expect.arrayContaining([adminNode.id, left.id, right.id]),
  );
  expect(visible.find((a: any) => a.id === adminNode.id).managerId).toBeNull();
  expect(
    (await s.call("send_message", { to: "agent", id: right.id, message: "coordinate" })).waiting,
  ).toBeUndefined();
  expect(
    (await k.db.pool.query("select 1 from approvals where subject_id=$1", [left.id])).rowCount,
  ).toBe(0);
  const read = await s.call("read", { nodeId: resource.id });
  expect(read.waiting).toBe("approval");
});

it("tracks unread delivery for every message and keeps one record per recipient on replay", async () => {
  const a = await agent(),
    b = await agent(),
    s = await start();
  await s.call("send_message", { to: "agent", id: a.id, message: "FYI" });
  expect(
    (await k.db.pool.query("select 1 from message_deliveries where canvas_id=$1", [board]))
      .rowCount,
  ).toBe(1);
  const args = {
    to: "agents",
    ids: [a.id, b.id],
    message: "question",
    expectReply: true,
    replyWithinSeconds: 1,
  };
  const sent = await s.call("send_message", args, "send-once");
  expect(sent.value.deliveries).toHaveLength(2);
  expect((await s.call("send_message", args, "send-once")).value).toEqual(sent.value);
  expect(
    (await k.db.pool.query("select 1 from message_deliveries where canvas_id=$1", [board]))
      .rowCount,
  ).toBe(3);
});

it("reviews actual work and new input without a model-side confirmation token", async () => {
  const s = await start();
  expect((await s.call("review_progress", {})).value.error.code).toBe("TOOL_ARGUMENTS");
  expect(
    (await s.call("review_progress", { outcome: "completed", reason: "done" })).value.error.code,
  ).toBe("PROGRESS_NEW_INPUT");
  await consume(s);
  expect(
    (await s.call("review_progress", { outcome: "completed", reason: "Verified assigned work" }))
      .value.reviewed,
  ).toBe(true);
  expect(
    (
      await s.call("review_progress", {
        outcome: "waiting",
        reason: "No actual dependency",
        remaining_work: "deliver",
        dependency_ids: ["forged"],
      })
    ).value.error.code,
  ).toBe("PROGRESS_DEPENDENCY");
  await k.db.canvas(board, (tx) =>
    k.conversations.append(tx, s.run.subject_id, key(), "user", { text: "new work" }, s.run.id),
  );
  expect(
    (await s.call("review_progress", { outcome: "completed", reason: "old result" })).value.error
      .code,
  ).toBe("PROGRESS_NEW_INPUT");
});

it("keeps incoming reply responsibilities until actual delivery", async () => {
  const a = await agent(),
    b = await agent(),
    sender = await start(a.id),
    recipient = await start(b.id);
  const req = (
    await sender.call("send_message", {
      to: "agent",
      id: b.id,
      message: "answer me",
      expectReply: true,
    })
  ).value.deliveries[0].id;
  await consume(recipient);
  const mailbox = (await recipient.call("read_inbox", {})).value;
  expect(mailbox.items.some((i: any) => i.kind === "incoming" && i.id === req)).toBe(true);
  expect(
    (await recipient.call("review_progress", { outcome: "completed", reason: "claim" })).value.error
      .code,
  ).toBe("PROGRESS_OBLIGATIONS");
  expect(
    (
      await recipient.call("update_message", {
        delivery_id: req,
        action: "background",
        reason: "ignore",
      })
    ).result.isError,
  ).toBe(true);
  await recipient.call("send_message", {
    to: "reply",
    id: req,
    kind: "result",
    message: "answered",
  });
  expect(
    (await k.db.pool.query("select state from message_deliveries where id=$1", [req])).rows[0]
      .state,
  ).toBe("replied");
  await consume(sender);
  expect(
    (
      await recipient.call("review_progress", {
        outcome: "completed",
        reason: "Requested result verified and delivered",
      })
    ).value.reviewed,
  ).toBe(true);
});

it("emits one timeout hook per deadline version, wakes a waiting sender, and preserves read evidence", async () => {
  const a = await agent(),
    b = await agent(),
    sender = await start(a.id),
    recipient = await start(b.id);
  const req = (
    await sender.call("send_message", {
      to: "agent",
      id: b.id,
      message: "check",
      expectReply: true,
    })
  ).value.deliveries[0].id;
  await consume(recipient);
  await k.db.pool.query(
    "update runs set state='waiting',reason='message',owner_id=null,lease_until=null where id=$1",
    [sender.run.id],
  );
  await expire(req);
  await Promise.all([k.tools.messages.tick(), k.tools.messages.tick()]);
  const delivered = await notices(sender.run.subject_id);
  expect(delivered).toHaveLength(1);
  expect(delivered[0].content.deliveries[0].readAt).toBeTruthy();
  expect((await k.runs.get(sender.run.id)).state).toBe("queued");
  await k.tools.messages.tick();
  expect(await notices(sender.run.subject_id)).toHaveLength(1);
  const state = (await k.db.pool.query("select version from message_deliveries where id=$1", [req]))
    .rows[0];
  await k.tools.messages.updateForOwner(req, "wait", 60, state.version);
  await expire(req);
  await k.tools.messages.tick();
  expect(await notices(sender.run.subject_id)).toHaveLength(1);
  await k.db.pool.query(
    "update messages set created_at=now()-interval '2 minutes' where conversation_id=$1 and role='message_notice'",
    [sender.run.subject_id],
  );
  await k.tools.messages.tick();
  expect(await notices(sender.run.subject_id)).toHaveLength(2);
});

it("routes a child reply back to the original workspace conversation and closes only that request", async () => {
  const a = await agent(),
    owner = await start(),
    child = await start(a.id);
  const first = (
    await owner.call("send_message", { to: "agent", id: a.id, message: "first", expectReply: true })
  ).value.deliveries[0].id;
  const second = (
    await owner.call("send_message", {
      to: "agent",
      id: a.id,
      message: "second",
      expectReply: true,
    })
  ).value.deliveries[0].id;
  await child.call("send_message", {
    to: "reply",
    id: first,
    kind: "result",
    message: "finished first",
  });
  const q = (
    await k.db.pool.query("select id,state from message_deliveries where id=any($1)", [
      [first, second],
    ])
  ).rows;
  expect(q.find((r) => r.id === first).state).toBe("replied");
  expect(q.find((r) => r.id === second).state).toBe("open");
  expect(
    (
      await k.db.pool.query(
        "select 1 from messages where conversation_id=$1 and content->>'text'='finished first'",
        [owner.run.subject_id],
      )
    ).rowCount,
  ).toBe(1);
  await expire(first);
  await k.tools.messages.tick();
  expect(await notices(owner.run.subject_id)).toHaveLength(0);
});

it("wait postpones reminders without changing the deadline or sending; expedite is bound to the original request and rate limited", async () => {
  const adminNode = await agent(board, false, "admin"),
    a = await agent(adminNode.id),
    b = await agent(adminNode.id),
    sender = await start(a.id),
    recipient = await start(b.id);
  const req = (
    await sender.call("send_message", {
      to: "agent",
      id: b.id,
      message: "original question",
      expectReply: true,
    })
  ).value.deliveries[0].id;
  const before = (
    await k.db.pool.query("select message_seq from conversations where id=$1", [
      recipient.run.subject_id,
    ])
  ).rows[0].message_seq;
  await sender.call("update_message", {
    delivery_id: req,
    action: "wait",
    wait_seconds: 1,
    reason: "Follow up the assigned request",
  });
  expect(
    (
      await k.db.pool.query("select message_seq from conversations where id=$1", [
        recipient.run.subject_id,
      ])
    ).rows[0].message_seq,
  ).toBe(before);
  const expedited = await sender.call("update_message", {
    delivery_id: req,
    action: "expedite",
    wait_seconds: 60,
    reason: "Follow up the assigned request",
  });
  expect(expedited.result.isError).not.toBe(true);
  const follow = (
    await k.db.pool.query(
      "select content,expedite_run_id from messages where conversation_id=$1 and content->>'priority'='expedited'",
      [recipient.run.subject_id],
    )
  ).rows[0];
  expect(follow.content.text).toContain("original question");
  expect(follow.content.replyTo.id).toBe(req);
  expect(follow.expedite_run_id).toBe(recipient.run.id);
  expect(
    (
      await sender.call("update_message", {
        delivery_id: req,
        action: "expedite",
        reason: "Follow up the assigned request",
      })
    ).value.error.code,
  ).toBe("EXPEDITE_COOLDOWN");
  await consume(recipient);
  expect(
    (
      await recipient.call("update_message", {
        delivery_id: req,
        action: "cancel",
        reason: "Follow up the assigned request",
      })
    ).value.error.code,
  ).toBe("FORBIDDEN");
});

it("stops tracking on sender Stop and never wakes stopped or deleted canvases", async () => {
  const a = await agent(),
    b = await agent(),
    sender = await start(a.id),
    recipient = await start(b.id);
  const req = (
    await sender.call("send_message", {
      to: "agent",
      id: b.id,
      message: "deadline",
      expectReply: true,
    })
  ).value.deliveries[0].id;
  await k.runs.cancel(sender.run.id);
  await expire(req);
  await k.tools.messages.tick();
  expect(await notices(sender.run.subject_id)).toHaveLength(0);
  expect(
    (await k.db.pool.query("select state from message_deliveries where id=$1", [req])).rows[0]
      .state,
  ).toBe("cancelled");
  await k.db.pool.query("update canvases set deleted_at=now() where id=$1", [board]);
  await k.tools.messages.tick();
  expect((await k.runs.get(recipient.run.id)).state).toBe("running");
});

it("keeps reviewed dependencies during ordinary reminders and preserves version checks for user actions", async () => {
  const a = await agent(),
    s = await start();
  const req = (
    await s.call("send_message", { to: "agent", id: a.id, message: "deadline", expectReply: true })
  ).value.deliveries[0].id;
  expect((await review(s)).waiting).toBe("message");
  await expire(req);
  await k.tools.messages.tick();
  await consume(s);
  expect((await review(s)).waiting).toBe("message");
  await k.tools.messages.updateForOwner(req, "wait", 120, 1);
  await expect(k.tools.messages.updateForOwner(req, "cancel", 120, 1)).rejects.toMatchObject({
    code: "VERSION_CONFLICT",
  });
});

it("coalesces equivalent pending permission requests and preserves the original executable receipt", async () => {
  const manager = await agent(board, false, "admin"),
    member = await agent(manager.id),
    s = await start(member.id);
  const n = (
    await k.graph.createNode({
      kind: "text",
      title: "restricted",
      text: "evidence",
      parentId: board,
      position,
      idempotencyKey: key(),
    })
  ).node;
  const args = { nodeId: n.id };
  const first = await s.call("read", args);
  expect(first.waiting).toBe("approval");
  const repeated = await s.call("read", args);
  expect(repeated.value.error.code).toBe("APPROVAL_PENDING");
  expect(repeated.value.error.requestId).toBe(first.value.requestId);
  expect(
    (
      await k.db.pool.query("select 1 from approvals where subject_id=$1 and status='pending'", [
        member.id,
      ])
    ).rowCount,
  ).toBe(1);
  await k.access.decide(first.value.requestId, 1, "approve", "authorized");
  const original = await s.call("read", args, first.logical);
  expect(original.result.isError).not.toBe(true);
  expect((await s.call("read", args)).result.isError).not.toBe(true);
});

it("conversation intrica-file references download immutable published bytes within the sender's resource grants", async () => {
  const { FileReferences } = await import("../../apps/server/dist/modules/work/file-references.js");
  const manager = await agent(board, false, "admin"),
    member = await agent(manager.id),
    outsider = await agent(),
    s = await start(member.id);
  const path = join(await k.host.workspace(board, member.id), "scene.html");
  const bytes = Buffer.from("<!doctype html><canvas></canvas><script>renderScene()</script>");
  await writeFile(path, bytes);
  const artifact = (await s.call("create_artifact", { kind: "text", title: "scene.html", path }))
    .value;
  expect(artifact.sharedWith).toContain(manager.id);
  const link = `intrica-file:${artifact.id}`;
  const sent = await s.call("send_message", {
    to: "manager",
    kind: "result",
    message: `[Download](${link})`,
    fileIds: [artifact.id],
  });
  expect(sent.value.delivered).toBe(1);
  const references = new FileReferences(k, "reference-server");
  const ref = (id: string) =>
    Buffer.from(
      JSON.stringify({ serverId: "reference-server", origin: { kind: "agent", id }, path: link }),
    ).toString("base64url");
  const preview = await references.preview(ref(manager.id));
  expect(preview.text).toContain("renderScene()");
  await writeFile(path, "changed after publication");
  const downloaded = await references.download(ref(manager.id), AbortSignal.timeout(5000));
  const chunks: Buffer[] = [];
  for await (const part of downloaded.stream) chunks.push(Buffer.from(part));
  expect(Buffer.concat(chunks)).toEqual(bytes);
  expect(downloaded.name).toBe("scene.html");
  await expect(references.resolve(ref(outsider.id))).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("delivers reply addresses and timeout hook arguments into actual model context", async () => {
  const { Agent } = await import("../../apps/server/dist/adapters/model/agent.js");
  const inputs: string[] = [];
  const turn = Agent.prototype.turn;
  vi.spyOn(Agent.prototype, "turn").mockImplementation(async function (
    this: InstanceType<typeof Agent>,
    ...args: Parameters<typeof turn>
  ) {
    inputs.push(
      this.state.messages
        .filter((m) => m.role === "user")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n"),
    );
    return turn.apply(this, args);
  });
  const a = await agent(),
    b = await agent(),
    sender = await start(a.id),
    recipient = await start(b.id);
  const requestId = (
    await sender.call("send_message", {
      to: "agent",
      id: b.id,
      message: "verify question",
      expectReply: true,
      replyWithinSeconds: 30,
    })
  ).value.deliveries[0].id;
  await executeConversation(k, recipient.ctx, (ctx, input) => k.tools.create(ctx, input));
  const received = inputs
    .flatMap((text) => text.split("\n"))
    .find((line) => line.includes('"replyTo"'))!;
  const address = JSON.parse(received.slice(received.indexOf("{")));
  expect(address).toMatchObject({
    deliveryId: requestId,
    replyTo: { to: "reply", id: requestId },
    expectReply: true,
    replyWithinSeconds: 30,
  });
  await expire(requestId);
  await k.tools.messages.tick();
  await executeConversation(k, sender.ctx, (ctx, input) => k.tools.create(ctx, input));
  expect(
    inputs.some(
      (text) =>
        text.includes(requestId) &&
        text.includes('"hook":"update_message"') &&
        text.includes('"actions":["wait","expedite","cancel"]'),
    ),
  ).toBe(true);
});
