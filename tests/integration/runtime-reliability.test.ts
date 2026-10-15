import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRole } from "@intrica/contracts";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { buildConversationPrompt } from "../../apps/server/dist/adapters/model/conversation-prompt.js";
import { modelProgress } from "../../apps/server/dist/adapters/model/progress.js";
import { digest } from "../../apps/server/dist/adapters/postgres/database.js";
import { grantsFor } from "../../apps/server/dist/modules/access/policy.js";
import { coveringGrant } from "../../apps/server/dist/modules/access/resources.js";
import { cancelAgents } from "../../apps/server/dist/modules/execution/cancellation.js";
import {
  invokeTool,
  TOOL_SCHEMA_VERSION,
} from "../../apps/server/dist/modules/execution/tool-calls.js";
import { Activity } from "../../apps/server/dist/modules/work/activity.js";
import { finishConversation } from "../../apps/server/dist/modules/work/conversation-runtime/finish.js";
import { recoverCheckpointTools } from "../../apps/server/dist/modules/work/conversation-runtime/recovery.js";
import { completionState } from "../../apps/server/dist/modules/work/progress/completion.js";
import { consumeInput } from "./helpers/tool-session.js";

const key = () => randomUUID();
const database = `intrica_reliability_${key().replaceAll("-", "")}`;
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
  board = (await k.graph.createCanvas({ title: "Reliability", idempotencyKey: key() })).node.id;
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
  const run = (await k.runs.claim("reliability"))!;
  expect(run.id).toBe(submitted.run.id);
  const ctx = { run, store: k.runs, signal: new AbortController().signal, progress() {} };
  const tools = await k.tools.create(ctx, run.frozen_input);
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
type Session = Awaited<ReturnType<typeof start>>;
async function artifact(s: Session, name = "evidence.txt") {
  const path = join(await k.host.workspace(board, s.actor.agentId), name);
  const bytes = Buffer.from("immutable verification bytes\n");
  await writeFile(path, bytes);
  const saved = await s.call("create_artifact", { kind: "text", title: name, path });
  expect(saved.result.isError).not.toBe(true);
  const node = await k.graph.queries.node(saved.value.id);
  return { path, bytes, node };
}
async function review(s: Session, decide?: (item: any) => object) {
  await consume(s);
  if (decide) {
    const inbox = (await s.call("read_inbox", {})).value;
    for (const item of inbox.items) {
      const decision = decide(item) as any;
      await s.call("update_message", {
        [item.kind === "removal" ? "message_id" : "delivery_id"]: item.ref,
        action: item.kind === "removal" ? "handled" : "cancel",
        reason: decision.reason,
      });
    }
  }
  return s.call("review_progress", {
    outcome: "completed",
    reason: "Assigned deliverable verified; remaining reassignment is explicitly recorded",
  });
}
async function consume(s: Session) {
  return consumeInput(k, s);
}

it("keeps snapshots out of raw path authority and bounds repeated approval maintenance", async () => {
  const manager = await agent(board, "admin"),
    member = await agent(manager.id, "read");
  const sender = await start(manager.id),
    reader = await start(member.id);
  const file = await artifact(sender);
  const granted = await sender.call("grant_resources", {
    agentId: member.id,
    resources: [{ nodeId: file.node.id, expectedRevision: file.node.revision, mode: "read" }],
  });
  expect(granted.result.isError).not.toBe(true);
  const grants = await grantsFor(k.db.pool, member.id);
  expect(
    await coveringGrant(grants, { id: file.node.id, resource: file.node.resource }, "read"),
  ).toBeDefined();
  expect(
    await coveringGrant(grants, { resource: { type: "file", path: file.path } }, "read"),
  ).toBeUndefined();
  const pending = await reader.call("read", { path: file.path });
  expect(pending.waiting).toBe("approval");
  for (let i = 0; i < 6; i++) {
    await k.access.maintain();
    const receipt = await reader.call("read", { path: file.path }, pending.logical);
    expect(receipt.value.requestId).toBe(pending.value.requestId);
  }
  const approvals = (
    await k.db.pool.query("select * from approvals where subject_id=$1", [member.id])
  ).rows;
  expect(approvals).toHaveLength(1);
  expect(approvals[0].status).toBe("pending");
  // Simulate a stale reconciler receipt: it must terminate, never create another request.
  await k.db.pool.query("update approvals set status='satisfied' where id=$1", [
    pending.value.requestId,
  ]);
  await k.db.pool.query("update tool_calls set state='prepared',result=null where approval_id=$1", [
    pending.value.requestId,
  ]);
  const stopped = await reader.call("read", { path: file.path }, pending.logical);
  expect(stopped.value).toMatchObject({
    call: { effect: "none" },
    error: { code: "AUTHORIZATION_CHANGED" },
  });
  expect(
    (await k.db.pool.query("select count(*) from approvals where subject_id=$1", [member.id]))
      .rows[0].count,
  ).toBe("1");
  const request = await reader.call("request_permission", {
    scope: { kind: "path", path: file.path, access: "file", mode: "read" },
    reason: "Read explicitly authorized source",
  });
  expect(request.waiting).toBe("approval");
  await k.access.decide(request.value.requestId, 1, "approve", "source read", sender.actor);
  const loaded = await reader.call("read", { path: file.path });
  expect(loaded.value.text).toBe(file.bytes.toString());
  const rawGrant = await coveringGrant(
    await grantsFor(k.db.pool, member.id),
    { resource: { type: "file", path: file.path } },
    "read",
  );
  expect(rawGrant?.resource_id).not.toBe(file.node.id);
  expect(rawGrant?.resource?.snapshot).toBeUndefined();
  expect((await k.host.scope({ agentId: member.id })).roots.some((r) => r.path === file.path)).toBe(
    true,
  );
  const stale = await sender.call("review_access_request", {
    requestId: request.value.requestId,
    version: 1,
    decision: "approve",
    reason: "old decision",
  });
  expect(stale.value.call.effect).toBe("none");
});

it("copies only the authorized snapshot, verifies bytes, and refuses symlinks, overwrites and stale revisions", async () => {
  const manager = await agent(board, "admin"),
    member = await agent(manager.id, "read");
  const sender = await start(manager.id),
    reader = await start(member.id);
  const file = await artifact(sender);
  await sender.call("grant_resources", {
    agentId: member.id,
    resources: [{ nodeId: file.node.id, expectedRevision: file.node.revision, mode: "read" }],
  });
  await writeFile(file.path, "new source version");
  const args = {
    nodeId: file.node.id,
    expectedRevision: file.node.revision,
    fileName: "review.txt",
  };
  const copied = await reader.call("copy_artifact", args);
  expect(copied.result.isError).not.toBe(true);
  expect(await readFile(copied.value.path)).toEqual(file.bytes);
  expect(copied.value.hash).toBe(createHash("sha256").update(file.bytes).digest("hex"));
  expect((await reader.call("copy_artifact", args)).value.reused).toBe(true);
  await writeFile(copied.value.path, "my notes");
  expect((await reader.call("copy_artifact", args)).value.error.code).toBe("DESTINATION_EXISTS");
  expect(await readFile(copied.value.path, "utf8")).toBe("my notes");
  const scratch = await k.host.workspace(board, member.id);
  await symlink(file.path, join(scratch, "link.txt"));
  expect(
    (await reader.call("copy_artifact", { ...args, fileName: "link.txt" })).value.call.effect,
  ).toBe("none");
  expect(
    (await reader.call("copy_artifact", { ...args, fileName: "../escape" })).value.call.effect,
  ).toBe("none");
  expect(
    (await reader.call("copy_artifact", { ...args, expectedRevision: file.node.revision + 1 }))
      .value.error.code,
  ).toBe("TARGET_CHANGED");
  expect((await k.host.scope({ agentId: member.id })).roots.some((r) => r.path === file.path)).toBe(
    false,
  );
  const command = await reader.call("bash", { command: "cat review.txt", cwd: scratch });
  expect(command.waiting).toBeUndefined();
  expect(JSON.stringify(command.value)).toContain("my notes");
});

it("delegates atomically, preserves stronger modes and checks team membership and versions", async () => {
  const manager = await agent(board, "admin"),
    member = await agent(manager.id),
    outside = await agent();
  const s = await start(manager.id),
    file = await artifact(s);
  const resources = [{ nodeId: file.node.id, expectedRevision: file.node.revision, mode: "write" }];
  const invalid = await s.call("grant_resources", {
    agentId: member.id,
    resources: [...resources, { ...resources[0], nodeId: manager.id }],
  });
  expect(invalid.result.isError).toBe(true);
  expect((await grantsFor(k.db.pool, member.id)).some((g) => g.resource_id === file.node.id)).toBe(
    false,
  );
  expect(
    (await s.call("grant_resources", { agentId: outside.id, resources })).value.error.code,
  ).toBe("FORBIDDEN");
  expect(
    (
      await s.call("grant_resources", {
        agentId: member.id,
        resources: [{ ...resources[0], expectedRevision: 99 }],
      })
    ).value.error.code,
  ).toBe("VERSION_CONFLICT");
  expect(
    (await s.call("grant_resources", { agentId: member.id, resources })).result.isError,
  ).not.toBe(true);
  expect(
    (
      await s.call("grant_resources", {
        agentId: member.id,
        resources: [{ ...resources[0], mode: "read" }],
      })
    ).result.isError,
  ).not.toBe(true);
  expect(
    (await grantsFor(k.db.pool, member.id)).find((g) => g.resource_id === file.node.id)?.mode,
  ).toBe("write");
});

it("keeps the manager running on dismissal and requires explicit handling of unfinished handoffs", async () => {
  const manager = await agent(board, "admin"),
    s = await start(manager.id);
  const hired = await s.call("hire_agent", {
    persona: "QA",
    role: "read",
    task: "Validate bytes",
    respondToResources: false,
  });
  expect(hired.result.isError).not.toBe(true);
  const memberId = hired.value.id;
  const delivery = (
    await k.db.pool.query("select id from message_deliveries where recipient_agent_id=$1", [
      memberId,
    ])
  ).rows[0].id;
  expect((await s.call("dismiss_agent", { agentId: memberId })).result.isError).not.toBe(true);
  expect(await k.runs.get(s.run.id)).toMatchObject({ state: "running", cancel_requested_at: null });
  expect(
    (await k.db.pool.query("select paused from agent_configs where node_id=$1", [manager.id]))
      .rows[0].paused,
  ).toBe(false);
  await consume(s);
  await k.tools.messages.tick();
  expect(await k.tools.messages.status(delivery)).toMatchObject({
    pending: true,
    closed: true,
    tracking_stopped: false,
  });
  expect((await completionState(k.db.pool, s.run.subject_id, s.run.id)).kind).toBe("review");
  const missing = await review(s);
  expect(missing.value.error.code).toBe("PROGRESS_OBLIGATIONS");
  const confirmed = await review(s, () => ({
    action: "handled",
    reason: "The remaining validation is reassigned to the manager; delivery is still pending.",
  }));
  expect(confirmed.value.outcome).toBe("completed");
  expect(await k.tools.messages.status(delivery)).toMatchObject({
    tracking_stopped: true,
    state: "open",
  });
  expect(
    (
      await s.call("review_progress", {
        outcome: "waiting",
        reason: "Nothing pending",
        remaining_work: "None",
        dependency_ids: [],
      })
    ).value.error.code,
  ).toBe("PROGRESS_DEPENDENCY");
});

it("preserves unread input when resource authority is revoked", async () => {
  const a = await agent(),
    s = await start(a.id);
  const note = (
    await k.graph.createNode({
      kind: "text",
      title: "source",
      parentId: board,
      position,
      text: "read",
      idempotencyKey: key(),
    })
  ).node;
  const link = await k.graph.createLink({ fromId: a.id, toId: note.id, idempotencyKey: key() });
  await k.graph.deleteLink(link.edge.id, { idempotencyKey: key() });
  expect((await k.runs.get(s.run.id)).cancel_requested_at).not.toBeNull();
  const c = (await k.db.pool.query("select * from conversations where id=$1", [s.run.subject_id]))
    .rows[0];
  expect(Number(c.consumed_message_seq)).toBeLessThan(Number(c.message_seq));
  expect(
    (
      await k.db.pool.query(
        "select consumed_at,run_id from messages where conversation_id=$1 and role='user'",
        [c.id],
      )
    ).rows[0],
  ).toMatchObject({ consumed_at: null, run_id: null });
});

it("finishes verified delivery and requires real wake dependencies for waiting", async () => {
  const a = await agent(),
    s = await start(a.id);
  await consume(s);
  const confirmed = await review(s);
  expect(confirmed.value.outcome).toBe("completed");
  expect(
    (
      await s.call("review_progress", {
        outcome: "waiting",
        reason: "Future watch needs a real schedule",
        remaining_work: "Watch",
        dependency_ids: ["nonexistent"],
      })
    ).value.error.code,
  ).toBe("PROGRESS_DEPENDENCY");
  expect(
    (await s.call("send_message", { to: "user", kind: "result", message: "Validated delivery" }))
      .result.isError,
  ).not.toBe(true);
  expect(
    await finishConversation(
      s.ctx,
      s.run.frozen_input,
      async () => false,
      async () => false,
      async () => null,
      () => false,
      async () => {},
    ),
  ).toBe(true);
  expect((await k.runs.get(s.run.id)).state).toBe("succeeded");
});

it("wakes a waiting sender when a recipient is removed, without treating its request as completed", async () => {
  const a = await agent(board, "admin"),
    b = await agent(a.id),
    s = await start(a.id);
  const sent = await s.call("send_message", {
    to: "agent",
    id: b.id,
    message: "review",
    expectReply: true,
  });
  await consume(s);
  await review(s, (item) => ({ action: item.kind === "message" ? "handled" : "wait" }));
  await k.runs.finish(s.run, "waiting", undefined, "message");
  await k.graph.deleteNodes({ canvasId: board, nodeIds: [b.id], idempotencyKey: key() });
  await k.tools.messages.tick();
  expect((await k.runs.get(s.run.id)).state).toBe("queued");
  expect(await k.tools.messages.status(sent.value.deliveries[0].id)).toMatchObject({
    pending: true,
    closed: true,
    state: "open",
  });
});

it("recovers a committed call across runs without repeating its effect or confusing a later turn", async () => {
  const a = await agent(),
    b = await agent(),
    s = await start(a.id);
  const turn = key(),
    callId = "same-provider-call",
    args = { to: "agent", id: b.id, message: "only once" };
  const checkpoint = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "send_message", arguments: args }],
    },
  ];
  await k.db.pool.query("update conversations set checkpoint=$2,context=$3 where id=$1", [
    s.run.subject_id,
    JSON.stringify(checkpoint),
    JSON.stringify({ pendingTurnId: turn, toolSchemaVersion: TOOL_SCHEMA_VERSION }),
  ]);
  const sent = await s.call("send_message", args, `${turn}:${callId}`);
  expect(sent.result.isError).not.toBe(true);
  await k.db.canvas(board, (tx) => cancelAgents(tx, [a.id], "permissions_changed"));
  await k.runs.fail(s.run, new Error("cancel before checkpoint"));
  const resumed = await start(a.id);
  const recovered = await recoverCheckpointTools(resumed.ctx);
  expect(recovered.blocked).toBe(false);
  expect(
    recovered.conversation.checkpoint.filter((m: any) => m.role === "toolResult"),
  ).toHaveLength(1);
  expect((await recoverCheckpointTools(resumed.ctx)).conversation.checkpoint).toEqual(
    recovered.conversation.checkpoint,
  );
  expect(
    (
      await k.db.pool.query(
        "select count(*) from message_deliveries where sender_conversation_id=$1",
        [s.run.subject_id],
      )
    ).rows[0].count,
  ).toBe("1");
  await k.db.pool.query("update conversations set checkpoint=$2,context=$3 where id=$1", [
    s.run.subject_id,
    JSON.stringify(checkpoint),
    JSON.stringify({ pendingTurnId: key() }),
  ]);
  expect((await recoverCheckpointTools(resumed.ctx)).conversation.checkpoint).toHaveLength(1);
});

it("does not replay an uncertain effect from an earlier run", async () => {
  const a = await agent(),
    s = await start(a.id);
  const turn = key(),
    args = { command: "external effect" };
  await k.db.pool.query(
    "insert into tool_calls(id,run_id,attempt_id,logical_call_id,name,args,args_hash,effect_class,state) values($1,$2,$3,$4,'bash',$5,$6,'external','dispatching')",
    [key(), s.run.id, s.run.attemptId, `${turn}:call`, JSON.stringify(args), digest(args)],
  );
  await k.db.pool.query("update conversations set checkpoint=$2,context=$3 where id=$1", [
    s.run.subject_id,
    JSON.stringify([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call", name: "bash", arguments: args }],
      },
    ]),
    JSON.stringify({ pendingTurnId: turn }),
  ]);
  await k.db.pool.query("update runs set state='cancelled' where id=$1", [s.run.id]);
  const resumed = await start(a.id);
  expect((await recoverCheckpointTools(resumed.ctx)).blocked).toBe(true);
  expect((await k.runs.conversationBarrier(s.run.subject_id)).unknown).toBe(true);
});

it("reports current receipts on conflicts, structural repairs, and model response activity", async () => {
  const a = await agent(),
    b = await agent(),
    s = await start(a.id);
  const sent = await s.call("send_message", {
    to: "agent",
    id: b.id,
    message: "validate",
    expectReply: true,
  });
  const delivery = sent.value.deliveries[0].id;
  await k.tools.messages.updateForOwner(delivery, "wait", 120, 1);
  await expect(k.tools.messages.updateForOwner(delivery, "expedite", 120, 1)).rejects.toMatchObject(
    { code: "VERSION_CONFLICT", details: { version: 2, receipt: { deliveryId: delivery } } },
  );
  const malformed = await s.call("read", { target: '{"kind":"path","path":"/tmp/a"}' });
  expect(malformed.value.error.nextAction).toContain("flat target");
  expect(malformed.value.call.effect).toBe("none");
  const id = key();
  await k.db.pool.query(
    "insert into model_calls(id,run_id,attempt_id,provider,model_id,protocol,purpose) values($1,$2,$3,'mock','mock','mock','conversation')",
    [id, s.run.id, s.run.attemptId],
  );
  const progress = modelProgress({ callId: id, db: k.db });
  await progress.observe("thinking_delta");
  await progress.observe("thinking_delta");
  await progress.flush();
  const status = (await new Activity(k.db).inspect(board, [a.id]))[0];
  expect(status?.model).toMatchObject({
    callId: id,
    phase: "thinking",
    active: true,
    elapsedSeconds: expect.any(Number),
    secondsSinceResponse: expect.any(Number),
  });
  expect(status?.model.firstResponseAt).toBeTruthy();
  expect(status?.model.lastResponseAt).toBeTruthy();
  for (const language of ["en", "zh-CN"] as const) {
    const prompt = buildConversationPrompt(language, {
      agent: true,
      role: "admin",
      selection: [],
      asyncSeconds: 5,
    });
    expect(prompt).toContain("review_progress");
    expect(prompt).toContain("handoffResourceIds");
    expect(prompt).toContain("grant_resources");
    expect(prompt).toContain("copy_artifact");
    expect(prompt).not.toContain("report_result");
  }
});

it("bounds removal wakeups at the collaboration activation limit", async () => {
  const a = await agent(board, "admin"),
    b = await agent(a.id),
    s = await start(a.id);
  await s.call("send_message", { to: "agent", id: b.id, message: "review", expectReply: true });
  await consume(s);
  await k.runs.finish(s.run, "waiting", undefined, "message");
  await k.db.pool.query("update runs set activation_count=$2 where id=$1", [
    s.run.cause_id,
    k.runs.limits.collaborationActivations,
  ]);
  await k.graph.deleteNodes({ canvasId: board, nodeIds: [b.id], idempotencyKey: key() });
  await Promise.all([k.tools.messages.tick(), k.tools.messages.tick()]);
  expect((await k.runs.get(s.run.id)).state).toBe("waiting");
  const notices = (
    await k.db.pool.query(
      "select content from messages where conversation_id=$1 and content->>'event'='member_removed'",
      [s.run.subject_id],
    )
  ).rows;
  expect(notices).toHaveLength(1);
  expect(notices[0].content.activationBlocked).toBe(true);
});
