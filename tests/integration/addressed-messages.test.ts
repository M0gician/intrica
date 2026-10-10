import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRole, Node } from "@intrica/contracts";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { withModelUsage } from "../../apps/server/dist/adapters/model/usage.js";
import type { Lease } from "../../apps/server/dist/modules/execution/store.js";
import { invokeTool } from "../../apps/server/dist/modules/execution/tool-calls.js";
import { conversationTrace } from "../../apps/server/dist/modules/work/trace.js";

const key = () => randomUUID();
const database = `addressed_${key().replaceAll("-", "")}`;
let app: Awaited<ReturnType<typeof buildServer>>,
  k: Kernel,
  admin: pg.Client,
  provider: Server,
  directory: string,
  board: string;
let respond: (body: any) => string;
let inputs: any[];
const activeRequest = (body: any) =>
  body.messages
    .find((m: any) => m.role === "system")
    .content.match(/Current work item: (request-[\w-]+)/)?.[1];
const answer = (body: any, text = "Verified result") =>
  JSON.stringify({
    target: { kind: "request", id: activeRequest(body) },
    kind: "result",
    message: text,
  });
beforeAll(async () => {
  provider = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    inputs.push(input);
    const text = respond(input);
    const chunk = (delta: object, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: key(), object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `${chunk({ role: "assistant", content: text }, null) + chunk({}, "stop")}data: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const url = new URL(process.env.INTRICA_TEST_ADMIN_URL!);
  admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  await admin.query(`create database ${database}`);
  url.pathname = `/${database}`;
  directory = await mkdtemp(join(tmpdir(), "intrica-addressed-"));
  app = await buildServer({
    databaseUrl: url.href,
    dataDir: directory,
    accessToken: key(),
    worker: false,
    model: {
      kind: "pi",
      provider: "openai",
      modelId: "addressed-fixture",
      apiKey: "fixture",
      baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
      supportsVision: false,
    },
  });
  await app.ready();
  k = app.kernel;
});
beforeEach(async () => {
  inputs = [];
  respond = (body) => answer(body);
  board = (await k.graph.createCanvas({ title: "Messages", idempotencyKey: key() })).node.id;
});
afterEach(async () => {
  await k.db.pool.query(
    "update runs set state='cancelled',cancel_requested_at=now() where state in('queued','running','waiting')",
  );
  await k.db.pool.query(
    "update messages set content=content||'{\"closed\":true}'::jsonb where consumed_run_id is null",
  );
  await k.db.pool.query("update approvals set status='cancelled' where status='pending'");
});
afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await admin.query(`drop database ${database} with(force)`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
});
const agent = async (parentId = board, role: AgentRole = "read") =>
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
const context = (run: Lease) => ({
  run,
  store: k.runs,
  signal: new AbortController().signal,
  progress() {},
});
async function start(member?: Node) {
  const submitted = await k.conversations.submit({
    canvasId: board,
    ...(member ? { agentId: member.id } : {}),
    message: "Analyze the supplied facts. Return an answer without work tools.",
    key: key(),
  });
  const run = (await k.runs.claim("test"))!;
  expect(run.id).toBe(submitted.run.id);
  const ctx = context(run);
  const tools = await k.tools.create(ctx, run.frozen_input);
  return { ...submitted, run, ctx, tools };
}
async function call(
  started: Awaited<ReturnType<typeof start>>,
  name: string,
  args: object,
  logical = key(),
) {
  const out = await invokeTool(
    started.ctx,
    started.tools.find((t) => t.name === name)!,
    logical,
    args,
  );
  return {
    ...out,
    value: out.result.isError
      ? (out.result.content[0] as any).text
      : JSON.parse((out.result.content[0] as any).text),
  };
}
async function execute(run?: Lease) {
  const lease = run ?? (await k.runs.claim("receiver"))!;
  expect(lease).toBeTruthy();
  await withModelUsage(
    {
      db: k.db,
      model: lease.frozen_input.model,
      purpose: "conversation",
      runId: lease.id,
      attemptId: lease.attemptId,
      canvasId: board,
      conversationId: lease.subject_id,
    },
    () => k.conversations.execute(context(lease), (ctx, input) => k.tools.create(ctx, input)),
  );
  return k.runs.get(lease.id);
}
const records = async (conversationId: string, role: string) =>
  (
    await k.db.pool.query(
      "select * from messages where conversation_id=$1 and role=$2 order by seq",
      [conversationId, role],
    )
  ).rows;

it("delivers a structured final answer to the user without tool calls", async () => {
  const s = await start();
  expect((await execute(s.run)).state).toBe("succeeded");
  expect((await records(s.conversationId, "assistant")).map((m) => m.content.text)).toEqual([
    "Verified result",
  ]);
  const trace = await conversationTrace(k.db, s.conversationId);
  expect(trace.models).toHaveLength(1);
  expect(trace.models[0].generation_id).toBe(trace.dispatches[0].logical_id.slice(6));
  expect(trace.models[0].work_item_id).toBe(s.run.frozen_input.workItemId);

  expect(
    (await k.db.pool.query("select * from tool_calls where run_id=$1", [s.run.id])).rows,
  ).toHaveLength(0);
  expect(
    (
      await k.db.pool.query(
        "select state from message_requests where recipient_conversation_id=$1",
        [s.conversationId],
      )
    ).rows[0].state,
  ).toBe("answered");
});
it("returns an Agent's final answer to its requester and retains request lineage", async () => {
  const a = await agent(board, "admin"),
    b = await agent(a.id);
  const s = await start(a);
  const sent = await call(s, "send_message", {
    target: { kind: "agent", agentId: b.id },
    kind: "request",
    message: "Compare these two independent claims without work tools.",
  });
  expect(sent.value.delivered).toBe(1);
  await k.maintain();
  expect((await execute()).state).toBe("succeeded");
  const returned = (await records(s.conversationId, "message")).filter(
    (m) => m.content.from === b.id,
  );
  expect(returned).toHaveLength(1);
  expect(returned[0].content.text).toBe("Verified result");
  expect(returned[0].content.workItemId).toBe(s.run.frozen_input.workItemId);
  expect(
    (
      await k.db.pool.query("select state from message_requests where id=$1", [
        sent.value.deliveries[0].requestId,
      ])
    ).rows[0].state,
  ).toBe("answered");
});
it("keeps internal notes private and leaves the request unanswered", async () => {
  const s = await start();
  respond = () =>
    JSON.stringify({ target: { kind: "internal" }, message: "Need one more observation" });
  const run = await execute(s.run);
  expect(run.state).toBe("waiting");
  expect(run.reason).toBe("reply_required");
  expect(await records(s.conversationId, "assistant")).toHaveLength(0);
  expect(await records(s.conversationId, "internal_note")).toHaveLength(1);
  expect(
    (
      await k.db.pool.query(
        "select state from message_requests where recipient_conversation_id=$1",
        [s.conversationId],
      )
    ).rows[0].state,
  ).toBe("open");
});
it("allows one correction for unaddressed text and publishes no draft", async () => {
  const s = await start();
  respond = () => "A plain answer without a recipient";
  const run = await execute(s.run);
  expect(run.reason).toBe("message_protocol");
  expect(inputs).toHaveLength(2);
  expect(await records(s.conversationId, "assistant")).toHaveLength(0);
  expect(await records(s.conversationId, "output_error")).toHaveLength(2);
});
it("deduplicates replay and refuses a second final reply", async () => {
  const s = await start();
  const requestId = s.run.frozen_input.workItemId;
  const payload = {
    target: { kind: "request", id: requestId },
    kind: "result",
    message: "One published result",
  };
  const logical = key();
  expect((await call(s, "send_message", payload, logical)).value.delivered).toBe(1);
  await call(s, "send_message", payload, logical);
  const duplicate = await call(s, "send_message", payload);
  expect(duplicate.result.isError).toBe(true);
  expect(await records(s.conversationId, "assistant")).toHaveLength(1);
});
it("creates a reply path for a workspace-hired Agent without a manager", async () => {
  const s = await start();
  const hired = await call(s, "hire_agent", {
    persona: "Check the supplied evidence",
    task: "Return the result to this request",
    role: "read",
    respondToResources: false,
  });
  expect(hired.value.id).toBeTruthy();
  await k.maintain();
  expect((await execute()).state).toBe("succeeded");
  const received = (await records(s.conversationId, "message")).filter(
    (m) => m.content.from === hired.value.id,
  );
  expect(received).toHaveLength(1);
  expect(received[0].content.workItemId).toBe(s.run.frozen_input.workItemId);
});
it("preserves one continuous context across two independent user requests", async () => {
  const s = await start();
  await k.conversations.submit({
    canvasId: board,
    conversationId: s.conversationId,
    message: "Second unrelated question",
    key: key(),
  });
  expect((await execute(s.run)).state).toBe("succeeded");
  expect(inputs).toHaveLength(2);
  expect(JSON.stringify(inputs[0])).not.toContain("Second unrelated question");
  expect(JSON.stringify(inputs[1])).toContain("Analyze the supplied facts");
  expect(JSON.stringify(inputs[1])).toContain("Verified result");
  expect(JSON.stringify(inputs[1])).toContain("Second unrelated question");
  expect(await records(s.conversationId, "assistant")).toHaveLength(2);
});
it("restores a final output after communication authorization without inventing a tool call", async () => {
  const a = await agent(board, "admin"),
    b = await agent();
  const s = await start(a);
  const sent = await call(s, "send_message", {
    target: { kind: "agent", agentId: b.id },
    kind: "request",
    message: "Return your assessment",
  });
  await k.maintain();
  const paused = await execute();
  expect(paused.reason).toBe("approval");
  const request = (
    await k.db.pool.query(
      "select * from approvals where origin_dispatch_id is not null and status='pending'",
    )
  ).rows[0];
  expect(request.origin_call_id).toBeNull();
  await k.access.decide(request.id, request.version, "approve", "Allow this reply");
  expect((await execute()).state).toBe("succeeded");
  expect(
    (
      await k.db.pool.query("select state from message_requests where id=$1", [
        sent.value.deliveries[0].requestId,
      ])
    ).rows[0].state,
  ).toBe("answered");
  expect(
    (await records(s.conversationId, "message")).filter((m) => m.content.from === b.id),
  ).toHaveLength(1);
});

it("creates a child question for a user and resumes the same work when the user answers", async () => {
  const s = await start();
  const question = await call(s, "send_message", {
    target: { kind: "request", id: s.run.frozen_input.workItemId },
    kind: "request",
    message: "Which constraint has priority?",
  });
  const child = question.value.deliveries[0].requestId;
  expect(child).toBeTruthy();
  const view = await k.conversations.read.view(s.conversationId);
  expect(view.messageRequests?.find((r) => r.id === child)).toMatchObject({
    recipientKind: "user",
    state: "open",
  });
  await k.conversations.submit({
    canvasId: board,
    conversationId: s.conversationId,
    message: "Accuracy",
    key: key(),
    association: { kind: "reply", requestId: child },
  });
  await execute(s.run);
  const states = (
    await k.db.pool.query(
      "select id,state from message_requests where recipient_conversation_id=$1",
      [s.conversationId],
    )
  ).rows;
  expect(states).toHaveLength(2);
  expect(states.every((r) => r.state === "answered")).toBe(true);
  expect(
    (await k.conversations.read.view(s.conversationId)).messages.some(
      (m) => m.role === "model_output",
    ),
  ).toBe(false);
});

it("does not block an unrelated task while a native output waits for communication permission", async () => {
  const a = await agent(),
    b = await agent();
  const privateResource = (
    await k.graph.createNode({
      kind: "text",
      parentId: board,
      title: "Private scope",
      text: "Restricted material",
      position: { x: 0, y: 0, width: 100, height: 100 },
      idempotencyKey: key(),
    })
  ).node;
  await k.graph.createLink({ fromId: b.id, toId: privateResource.id, idempotencyKey: key() });
  const s = await start(a);
  const first = s.run.frozen_input.workItemId;
  await k.conversations.submit({
    canvasId: board,
    agentId: a.id,
    message: "An independent request",
    key: key(),
  });
  respond = (body) =>
    activeRequest(body) === first
      ? JSON.stringify({
          target: { kind: "agent", agentId: b.id },
          kind: "update",
          message: "A bounded observation",
        })
      : answer(body, "Second work completed");
  const run = await execute(s.run);
  expect(run.reason).toBe("approval");
  expect((await records(s.conversationId, "assistant")).map((m) => m.content.text)).toEqual([
    "Second work completed",
  ]);
  const approval = (
    await k.db.pool.query(
      "select * from approvals where origin_dispatch_id is not null and canvas_id=$1",
      [board],
    )
  ).rows[0];
  await k.access.decide(approval.id, approval.version, "approve", "Allow this observation");
  await execute();
  const inbox = await k.conversations.read.forAgent(b.id);
  expect((await records(inbox.id, "message")).filter((m) => m.content.from === a.id)).toHaveLength(
    1,
  );
});

it.each([
  { target: { kind: "internal" }, message: "private", kind: "result" },
  { target: { kind: "internal" }, message: "private", fileIds: ["fake"] },
  { target: { kind: "agent", agentId: "missing" }, kind: "decline", message: "no" },
  { target: { kind: "request", id: "foreign" }, kind: "result", message: "forged" },
  { target: { kind: "manager" }, kind: "result", message: "No manager exists" },
  { target: { kind: "internal" }, message: " ", senderId: "forged" },
])("rejects invalid addressing without publishing: %j", async (payload) => {
  const s = await start();
  respond = () => JSON.stringify(payload);
  expect((await execute(s.run)).reason).toBe("message_protocol");
  expect(inputs).toHaveLength(2);
  expect(await records(s.conversationId, "assistant")).toHaveLength(0);
  expect(await records(s.conversationId, "message")).toHaveLength(0);
  expect(await records(s.conversationId, "internal_note")).toHaveLength(0);
});

it("replies to the requester when its identity differs from the direct manager", async () => {
  const manager = await agent(board, "admin"),
    b = await agent(manager.id),
    a = await agent(board, "admin");
  const caller = await start(a);
  const sent = await call(caller, "send_message", {
    target: { kind: "agent", agentId: b.id },
    kind: "request",
    message: "Answer this request",
  });
  await k.maintain();
  const recipientRun = (await k.runs.claim("recipient"))!;
  respond = () =>
    JSON.stringify({
      target: { kind: "request", id: sent.value.deliveries[0].requestId },
      kind: "result",
      message: "Original requester only",
    });
  expect((await execute(recipientRun)).reason).toBe("approval");
  const approval = (
    await k.db.pool.query("select * from approvals where canvas_id=$1 and status='pending'", [
      board,
    ])
  ).rows[0];
  await k.access.decide(approval.id, approval.version, "approve", "Reply allowed");
  await execute();
  expect(
    (await records(caller.conversationId, "message")).some(
      (m) => m.content.text === "Original requester only",
    ),
  ).toBe(true);
  const mc = await k.conversations.read.forAgent(manager.id);
  expect(
    (await records(mc.id, "message")).some((m) => m.content.text === "Original requester only"),
  ).toBe(false);
});

it("keeps a late business result passive after the originating task was stopped", async () => {
  const a = await agent(board, "admin"),
    b = await agent(a.id);
  const s = await start(a);
  await call(s, "send_message", {
    target: { kind: "agent", agentId: b.id },
    kind: "request",
    message: "Work in progress",
    lifetime: "independent",
  });
  await k.conversations.stop(a.id);
  await k.runs.fail(s.run, new Error("stopped"));
  await k.maintain();
  await execute();
  const received = (await records(s.conversationId, "message")).filter(
    (m) => m.content.from === b.id,
  );
  expect(received).toHaveLength(1);
  expect(received[0].content.passive).toBe(true);
  await k.maintain();
  expect((await k.runs.get(s.run.id)).state).toBe("cancelled");
});

it("invalidates a saved output when the conversation generation changes", async () => {
  const s = await start();
  await k.db.canvas(board, (tx) =>
    tx.query("update conversations set generation=generation+1 where id=$1", [s.conversationId]),
  );
  await expect(
    k.conversations.messaging.send(
      {
        run: s.run,
        conversationId: s.conversationId,
        agentId: null,
        generation: 0,
        origin: "final",
      },
      {
        target: { kind: "request", id: s.run.frozen_input.workItemId },
        kind: "result",
        message: "stale",
      },
      key(),
    ),
  ).rejects.toMatchObject({ code: "STALE_OUTPUT" });
  expect(await records(s.conversationId, "assistant")).toHaveLength(0);
});

it("marks requests unavailable when an Agent is deleted and preserves its identity", async () => {
  const a = await agent(board, "admin"),
    b = await agent(a.id);
  const s = await start(a);
  const sent = await call(s, "send_message", {
    target: { kind: "agent", agentId: b.id },
    kind: "request",
    message: "Pending work",
  });
  const c = await k.conversations.read.forAgent(b.id);
  await k.db.canvas(board, (tx) => tx.query("delete from nodes where id=$1", [b.id]));
  const row = (
    await k.db.pool.query("select identity_kind,agent_id from conversations where id=$1", [c.id])
  ).rows[0];
  expect(row).toEqual({ identity_kind: "deleted_agent", agent_id: null });
  expect(
    (
      await k.db.pool.query("select state from message_requests where id=$1", [
        sent.value.deliveries[0].requestId,
      ])
    ).rows[0].state,
  ).toBe("unavailable");
  await k.maintain();
  expect(
    (await k.db.pool.query("select * from runs where subject_id=$1", [c.id])).rows,
  ).toHaveLength(0);
});

it("transfers reply responsibility and routes a user's clarification back to the new executor", async () => {
  const manager = await agent(board, "admin"),
    member = await agent(manager.id);
  const source = await start(member);
  const originalRequest = source.run.frozen_input.workItemId;
  await k.runs.fail(source.run, new Error("interrupted"));
  const owner = await start(manager);
  const takeover = await call(owner, "take_over_run", { agentId: member.id, runId: source.run.id });
  expect(takeover.value.requestIds).toContain(originalRequest);
  const question = await call(owner, "send_message", {
    target: { kind: "request", id: originalRequest },
    kind: "request",
    message: "Which result format do you need?",
  });
  const child = question.value.deliveries[0].requestId;
  const answer = await k.conversations.submit({
    canvasId: board,
    agentId: member.id,
    message: "A short table",
    key: key(),
    association: { kind: "reply", requestId: child },
  });
  expect(answer.run.id).toBe(owner.run.id);
  const forwarded = (await records(owner.conversationId, "user")).find(
    (m) => m.content.inReplyTo === child,
  );
  expect(forwarded.content.workItemId).toBe(originalRequest);
  const result = await call(owner, "send_message", {
    target: { kind: "request", id: originalRequest },
    kind: "result",
    message: "Verified table",
    handoff: { sourceRunIds: [source.run.id] },
  });
  expect(result.value.informedExecutors).toEqual([member.id]);
  expect((await records(source.conversationId, "assistant")).at(-1).content.text).toBe(
    "Verified table",
  );
  const request = (
    await k.db.pool.query("select * from message_requests where id=$1", [originalRequest])
  ).rows[0];
  expect(request.state).toBe("answered");
  expect(request.recipient_conversation_id).toBe(owner.conversationId);
});

it("keeps two workspace return addresses distinct", async () => {
  const b = await agent();
  const first = await start();
  await call(first, "send_message", {
    target: { kind: "agent", agentId: b.id },
    kind: "request",
    message: "First workspace request",
  });
  const second = await start();
  await call(second, "send_message", {
    target: { kind: "agent", agentId: b.id },
    kind: "request",
    message: "Second workspace request",
  });
  await k.maintain();
  await execute();
  for (const s of [first, second]) {
    const returned = (await records(s.conversationId, "message")).filter(
      (m) => m.content.from === b.id,
    );
    expect(returned).toHaveLength(1);
    expect(returned[0].content.workItemId).toBe(s.run.frozen_input.workItemId);
  }
});

it.each(["deny", "expire", "escalate"] as const)(
  "a native send keeps its %s permission barrier after promotion",
  async (decision) => {
    const manager = await agent(board, "admin"),
      a = await agent(manager.id),
      b = await agent(board, "admin");
    const s = await start(a);
    respond = () =>
      JSON.stringify({
        target: { kind: "agent", agentId: b.id },
        kind: "update",
        message: "Restricted observation",
      });
    expect((await execute(s.run)).reason).toBe("approval");
    const dispatch = (
      await k.db.pool.query("select * from message_dispatches where run_id=$1", [s.run.id])
    ).rows[0];
    const approval = (
      await k.db.pool.query("select * from approvals where id=$1", [dispatch.approval_id])
    ).rows[0];
    if (decision === "expire")
      await k.db.pool.query(
        "update approvals set expires_at=now()-interval '1 second' where id=$1",
        [approval.id],
      );
    else await k.access.decide(approval.id, approval.version, decision, "Keep this send blocked");
    await k.db.pool.query(
      "update agent_configs set config=jsonb_set(config,'{role}','\"admin\"') where node_id=$1",
      [a.id],
    );
    await k.conversations.submit({
      canvasId: board,
      agentId: a.id,
      message: "Review current state",
      key: key(),
    });
    const lease = (await k.runs.claim("resume"))!;
    const send = k.conversations.messaging.send(
      {
        run: lease,
        conversationId: s.conversationId,
        agentId: a.id,
        origin: "final",
        generation: Number(dispatch.generation),
      },
      dispatch.payload,
      dispatch.logical_id,
    );
    if (decision === "escalate") expect(await send).toMatchObject({ status: "pending" });
    else await expect(send).rejects.toBeInstanceOf(Error);
    expect(await records((await k.conversations.read.forAgent(b.id)).id, "message")).toHaveLength(
      0,
    );
  },
);
