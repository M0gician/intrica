import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { MessageWaits } from "../../apps/server/dist/modules/collaboration/message-waits.js";
import {
  createRequest,
  settleRequest,
} from "../../apps/server/dist/modules/collaboration/requests.js";
import { expediteMessage } from "../../apps/server/dist/modules/collaboration/urgency.js";
import { retainDependency } from "../../apps/server/dist/modules/execution/request-lifecycle.js";
import { invokeTool } from "../../apps/server/dist/modules/execution/tool-calls.js";

const key = () => randomUUID();
const database = `intrica_message_waits_${key().replaceAll("-", "")}`;
const url = new URL(process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres");
let admin: pg.Client, app: Awaited<ReturnType<typeof buildServer>>, k: Kernel, directory: string;
beforeAll(async () => {
  admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  await admin.query(`create database ${database}`);
  url.pathname = `/${database}`;
  directory = await mkdtemp(join(tmpdir(), "intrica-message-waits-"));
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
  const canvasId = (await k.graph.createCanvas({ title: "Wait lifecycle", idempotencyKey: key() }))
    .node.id;
  const member = async (role: "read" | "admin", parentId = canvasId) =>
    (
      await k.graph.createNode({
        kind: "agent",
        parentId,
        title: key(),
        agent: { persona: "", role, enabled: false },
        position: { x: 0, y: 0, width: 220, height: 300 },
        idempotencyKey: key(),
      })
    ).node;
  const sender = await member("admin"),
    receiver = await member("read", sender.id);
  const submission = await k.conversations.submit({
    canvasId,
    agentId: sender.id,
    message: "Coordinate independent tasks",
    key: key(),
  });
  const run = (await k.runs.claim("wait-test"))!;
  expect(run.id).toBe(submission.run.id);
  const ctx = { run, store: k.runs, signal: new AbortController().signal, progress() {} };
  const tools = await k.tools.create(ctx, run.frozen_input);
  const call = async (name: string, args: object, logical = key()) => {
    const output = await invokeTool(ctx, tools.find((t) => t.name === name)!, logical, args);
    return { ...output, value: JSON.parse((output.result.content[0] as any).text) };
  };
  // A wait starts after the triggering input entered the saved context.
  await k.db.pool.query(
    "update messages set consumed_run_id=$2,consumed_at=now() where conversation_id=$1",
    [run.subject_id, run.id],
  );
  const sent = await call("send_message", {
    target: { kind: "agent", agentId: receiver.id },
    kind: "request",
    message: "Inspect a separate input",
  });
  expect(sent.result.isError).toBe(false);
  const requestId = sent.value.deliveries[0].requestId as string;
  const recipient = (await k.conversations.read.forAgent(receiver.id)).id;
  const wait = async (requestIds = [requestId]) => {
    const output = await call("wait_for_message", { requestIds, timeoutSeconds: 60 });
    expect(output.waiting).toBe("message");
    await k.runs.finish(run, "waiting", undefined, "message");
    return output.value.waitId as string;
  };
  const response = async (request = requestId) =>
    k.db.canvas(canvasId, (tx) =>
      k.conversations.append(
        tx,
        run.subject_id,
        key(),
        "message",
        {
          from: receiver.id,
          inReplyTo: request,
          workItemId: run.frozen_input.workItemId,
          text: "Progress",
          messageKind: "update",
        },
        run.id,
      ),
    );
  return {
    canvasId,
    sender,
    receiver,
    ctx,
    run,
    call,
    requestId,
    recipient,
    wait,
    response,
    member,
  };
}
const row = async (waitId: string) =>
  (await k.db.pool.query("select * from message_waits where id=$1", [waitId])).rows[0];
const notices = async (waitId: string) =>
  (
    await k.db.pool.query(
      "select * from messages where content->>'waitId'=$1 and role='wait_notice'",
      [waitId],
    )
  ).rows;

it("specified requests ignore unrelated messages, then release once across maintainer restarts", async () => {
  const s = await session(),
    id = await s.wait();
  await s.response("another-request");
  expect((await row(id)).state).toBe("active");
  expect((await k.runs.get(s.run.id)).state).toBe("waiting");
  await s.response();
  expect((await row(id)).release_reason).toBe("message");
  const restarted = new MessageWaits(k.db, k.runs);
  await restarted.maintain();
  await restarted.maintain();
  expect(await notices(id)).toHaveLength(1);
  expect((await k.runs.get(s.run.id)).state).toBe("queued");
});
it("a pending response cannot be lost between receipt and wait registration", async () => {
  const s = await session();
  await s.response();
  const output = await s.call("wait_for_message", { requestIds: [s.requestId], timeoutSeconds: 1 });
  expect(output.waiting).toBeUndefined();
  expect((await row(output.value.waitId)).release_reason).toBe("message");
});
it("timeout and delivery compete for one durable notice without sending a reminder or closing work", async () => {
  const s = await session(),
    id = await s.wait();
  await k.db.pool.query("update message_waits set deadline=now()-interval '1 second' where id=$1", [
    id,
  ]);
  await Promise.all([new MessageWaits(k.db, k.runs).maintain(), s.response()]);
  expect(await notices(id)).toHaveLength(1);
  expect(["message", "timeout"]).toContain((await row(id)).release_reason);
  const notice = (await notices(id))[0].content;
  expect(notice.requests[0]).toMatchObject({
    id: s.requestId,
    state: "open",
    followupCount: 0,
    receipt: "unread",
  });
  expect(
    (
      await k.db.pool.query(
        "select count(*)::int n from message_dispatches where conversation_id=$1",
        [s.run.subject_id],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("unknown outcomes defer a timer and stop cancels it without bypassing either barrier", async () => {
  const s = await session(),
    id = await s.wait();
  await k.db.pool.query(
    "update tool_calls set state='unknown' where run_id=$1 and name='send_message'",
    [s.run.id],
  );
  await k.db.pool.query("update message_waits set deadline=now()-interval '1 second' where id=$1", [
    id,
  ]);
  await k.conversations.waits.maintain();
  expect(await row(id)).toMatchObject({ state: "active", blocked_reason: "unknown" });
  expect(await notices(id)).toHaveLength(0);
  await expect(k.conversations.waits.control(s.run.subject_id, id, "wake")).rejects.toMatchObject({
    code: "INVALID_STATE",
  });
  await k.runs.cancel(s.run.id);
  await k.conversations.waits.maintain();
  expect((await row(id)).state).toBe("cancelled");
  expect(await notices(id)).toHaveLength(0);
});
it("followups use the original recipient, preserve work, and enforce per-request limits idempotently", async () => {
  const s = await session();
  const args = {
      target: { kind: "followup", id: s.requestId },
      kind: "update",
      message: "Additional evidence",
    },
    logical = key();
  const first = await s.call("send_message", args, logical);
  expect(first.result.isError).toBe(false);
  expect((await s.call("send_message", args, logical)).value).toEqual(first.value);
  const delivered = (
    await k.db.pool.query(
      "select content from messages where conversation_id=$1 and content->>'targetKind'='followup'",
      [s.recipient],
    )
  ).rows;
  expect(delivered).toHaveLength(1);
  expect(delivered[0].content.workItemId).toBe(s.requestId);
  expect((await s.call("send_message", args)).value.error).toBe("FOLLOWUP_LIMIT");
  expect(
    (
      await k.db.pool.query("select followup_count from message_requests where id=$1", [
        s.requestId,
      ])
    ).rows[0].followup_count,
  ).toBe(1);
});
it("closing one parent retains shared and independent children and closes only exclusive orphans", async () => {
  const s = await session(),
    parent = s.run.frozen_input.workItemId;
  const independent = await s.call("send_message", {
    target: { kind: "agent", agentId: s.receiver.id },
    kind: "request",
    message: "Independent work",
    lifetime: "independent",
  });
  const exclusive = await s.call("send_message", {
    target: { kind: "agent", agentId: s.receiver.id },
    kind: "request",
    message: "Exclusive work",
  });
  let retainedBy = "";
  await k.db.canvas(s.canvasId, async (tx) => {
    const other = await createRequest(tx, {
      canvasId: s.canvasId,
      messageId: key(),
      sender: { kind: "user", conversationId: s.run.subject_id },
      recipient: { kind: "agent", conversationId: s.run.subject_id, agentId: s.sender.id },
    });
    await retainDependency(tx, other.id, s.requestId);
    retainedBy = other.id;
    await settleRequest(tx, parent, key(), "result");
  });
  const states = (
    await k.db.pool.query("select id,state from message_requests where id=any($1::text[])", [
      [
        s.requestId,
        independent.value.deliveries[0].requestId,
        exclusive.value.deliveries[0].requestId,
      ],
    ])
  ).rows;
  expect(states.find((r) => r.id === s.requestId).state).toBe("open");
  expect(states.find((r) => r.id === independent.value.deliveries[0].requestId).state).toBe("open");
  expect(states.find((r) => r.id === exclusive.value.deliveries[0].requestId).state).toBe(
    "cancelled",
  );
  await k.maintain();
  const receiverRun = (await k.runs.claim("shared-reply"))!;
  expect(receiverRun.subject_id).toBe(s.recipient);
  const context = {
    run: receiverRun,
    store: k.runs,
    signal: new AbortController().signal,
    progress() {},
  };
  const tools = await k.tools.create(context, receiverRun.frozen_input);
  const reply = await invokeTool(context, tools.find((t) => t.name === "send_message")!, key(), {
    target: { kind: "request", id: s.requestId },
    kind: "result",
    message: "Shared dependency result",
  });
  expect(reply.result.isError).not.toBe(true);
  const received = (
    await k.db.pool.query(
      "select content from messages where conversation_id=$1 and content->>'from'=$2",
      [s.run.subject_id, s.receiver.id],
    )
  ).rows;
  expect(received).toHaveLength(1);
  expect(received[0].content).toMatchObject({
    workItemId: retainedBy,
    text: "Shared dependency result",
  });
  expect(received[0].content.passive).not.toBe(true);
});
it("Agent urgency requires management authority, fences old output, and limits repeated interruptions", async () => {
  const s = await session(),
    peer = await s.member("read");
  const message = (
    await k.db.pool.query(
      "select client_message_id from messages where conversation_id=$1 and role='message'",
      [s.recipient],
    )
  ).rows[0].client_message_id;
  await expect(
    k.db.canvas(s.canvasId, (tx) => expediteMessage(tx, s.recipient, message, peer.id)),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await k.db.canvas(s.canvasId, (tx) => expediteMessage(tx, s.recipient, message, s.sender.id));
  expect(
    (await k.db.pool.query("select generation from conversations where id=$1", [s.recipient]))
      .rows[0].generation,
  ).toBe("1");
  const next = await s.call("send_message", {
    target: { kind: "followup", id: s.requestId },
    kind: "update",
    message: "More evidence",
    priority: "expedite",
  });
  expect(next.value.error).toBe("EXPEDITE_COOLDOWN");
  expect(
    (
      await k.db.pool.query("select followup_count from message_requests where id=$1", [
        s.requestId,
      ])
    ).rows[0].followup_count,
  ).toBe(0);
});
