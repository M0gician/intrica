import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRole } from "@intrica/contracts";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { Value } from "typebox/value";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { Agent } from "../../apps/server/dist/adapters/model/agent.js";
import { messagePromptContext } from "../../apps/server/dist/modules/collaboration/prompt-context.js";
import {
  createRequest,
  settleRequest,
} from "../../apps/server/dist/modules/collaboration/requests.js";
import { retainDependency } from "../../apps/server/dist/modules/execution/request-lifecycle.js";
import { invokeTool } from "../../apps/server/dist/modules/execution/tool-calls.js";
import { addressedOutput } from "../fixtures/addressed-output.mjs";

const key = () => randomUUID();
const database = `intrica_prompt_${key().replaceAll("-", "")}`;
let app: Awaited<ReturnType<typeof buildServer>>, k: Kernel, admin: pg.Client;
let directory: string, board: string;
beforeAll(async () => {
  const url = new URL(process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres");
  admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  await admin.query(`create database ${database}`);
  url.pathname = `/${database}`;
  directory = await mkdtemp(join(tmpdir(), "intrica-prompt-"));
  app = await buildServer({
    databaseUrl: url.href,
    dataDir: directory,
    worker: false,
    model: { kind: "mock", streamDelayMs: 0, supportsVision: false },
  });
  await app.ready();
  k = app.kernel;
});
beforeEach(async () => {
  board = (await k.graph.createCanvas({ title: "Prompt contracts", idempotencyKey: key() })).node
    .id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  k.runs.limits.conversationTurns = 0;
  k.runs.limits.toolInputRepairs = 2;
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

async function agent(role: AgentRole = "read", parentId = board) {
  return (
    await k.graph.createNode({
      kind: "agent",
      parentId,
      title: key(),
      agent: { role, persona: "PERSONA_MARKER", enabled: false },
      position: { x: 0, y: 0, width: 220, height: 300 },
      idempotencyKey: key(),
    })
  ).node;
}
async function start(agentId?: string, language: "en" | "zh-CN" = "en") {
  const submitted = await k.conversations.submit({
    canvasId: board,
    agentId,
    message: "Inspect the contract",
    language,
    key: key(),
  });
  const run = (await k.runs.claim("prompt-contract"))!;
  expect(run.id).toBe(submitted.run.id);
  const ctx = { run, store: k.runs, signal: new AbortController().signal, progress() {} };
  const tools = await k.tools.create(ctx, run.frozen_input);
  const call = async (name: string, args: object) => {
    const output = await invokeTool(ctx, tools.find((t) => t.name === name)!, key(), args);
    expect(output.result.isError).not.toBe(true);
    return JSON.parse((output.result.content[0] as { text: string }).text);
  };
  return { ctx, run, tools, call };
}

const cases = (["read", "write", "admin", "owner"] as const).flatMap((role) =>
  (["en", "zh-CN"] as const).map((language) => ({ role, language })),
);
it.each(cases)(
  "$role receives current tools, policy and valid closing output in $language",
  async ({ role, language }) => {
    vi.stubEnv("INTRICA_MESSAGE_FOLLOWUPS", "3");
    k.runs.limits.toolInputRepairs = 5;
    k.runs.limits.conversationTurns = 1;
    const member = role === "owner" ? undefined : await agent(role);
    const s = await start(member?.id, language);
    const schema = s.tools.find((t) => t.name === "send_message")!.parameters;
    let turn = 0;
    vi.spyOn(Agent.prototype, "turn").mockImplementation(async function (this: Agent) {
      turn++;
      const prompt = this.state.systemPrompt;
      expect(prompt).toContain(
        language === "en" ? `Current role: ${role}.` : `当前角色：${role}。`,
      );
      if (member) expect(prompt).toContain("PERSONA_MARKER");
      for (const tool of s.tools) {
        if (
          (tool.name.includes("_") || ["bash", "rg"].includes(tool.name)) &&
          !this.state.tools.some((t) => t.name === tool.name)
        )
          expect(prompt).not.toMatch(new RegExp(`\\b${tool.name}\\b`));
      }
      const metadata = JSON.parse(
        prompt.split("Current message requests (server metadata): ")[1]!.split("\n")[0]!,
      );
      expect(metadata.incoming.requests).toEqual([
        expect.objectContaining({ id: s.run.frozen_input.workItemId, senderKind: "user" }),
      ]);
      expect(metadata.outgoing.requests).toEqual([]);
      if (turn === 1) {
        expect(this.state.tools.length).toBeGreaterThan(0);
        expect(prompt).toContain(language === "en" ? "limit is 3" : "上限为 3 次");
        expect(prompt).toContain(language === "en" ? "allows 5 corrections" : "修正 5 次");
        const send = this.state.tools.find((t) => t.name === "send_message")!;
        expect(send.description).toContain(language === "en" ? "limit is 3" : "最多跟进 3 次");
        expect(this.state.tools.some((t) => t.name === "hire_agent")).toBe(
          role === "admin" || role === "owner",
        );
        expect(this.state.tools.some((t) => t.name === "create_artifact")).toBe(role !== "read");
        expect(this.state.tools.some((t) => t.name === "take_over_run")).toBe(role === "admin");
        vi.stubEnv("INTRICA_MESSAGE_FOLLOWUPS", "0");
      } else {
        expect(this.state.tools).toEqual([]);
        expect(prompt).toContain(language === "en" ? "limit is 0" : "上限为 0 次");
        expect(prompt).toContain("kind=update");
        expect(prompt).toContain("kind=result");
        expect(Value.Check(schema, JSON.parse(addressedOutput(prompt, "Verified")))).toBe(true);
      }
      const message: Awaited<ReturnType<Agent["turn"]>> = {
        role: "assistant",
        api: this.state.model.api,
        provider: this.state.model.provider,
        model: this.state.model.id,
        content:
          turn === 1
            ? [{ type: "toolCall", id: key(), name: "read_canvas", arguments: {} }]
            : [{ type: "text", text: addressedOutput(prompt, "Verified") }],
        stopReason: turn === 1 ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      this.state.messages.push(message);
      return message;
    });
    await k.conversations.execute(s.ctx, (ctx, input) => k.tools.create(ctx, input));
    expect(turn).toBe(2);
    expect(
      (
        await k.db.pool.query("select state from message_requests where id=$1", [
          s.run.frozen_input.workItemId,
        ])
      ).rows[0].state,
    ).toBe("answered");
  },
);

it("request metadata keeps directions, current-task priority and partial-index boundaries", async () => {
  const sender = await agent("admin"),
    receiver = await agent("read", sender.id);
  const s = await start(sender.id);
  const sent = await s.call("send_message", {
    target: { kind: "agent", agentId: receiver.id },
    kind: "request",
    message: "Inspect a dependency",
    lifetime: "independent",
  });
  const requestId = sent.deliveries[0].requestId;
  let latest = "";
  await k.db.canvas(board, async (tx) => {
    for (let i = 0; i < 44; i++) {
      const request = await createRequest(tx, {
        canvasId: board,
        messageId: key(),
        sender: { kind: "user", conversationId: s.run.subject_id },
        recipient: { kind: "agent", conversationId: s.run.subject_id, agentId: sender.id },
      });
      latest = request.id;
    }
  });
  const context = await messagePromptContext(k.db.pool, s.run.subject_id, latest);
  expect(context.incoming).toMatchObject({ total: 45, truncated: true });
  expect(context.incoming.requests).toHaveLength(40);
  expect(context.incoming.requests[0].id).toBe(latest);
  expect(context.outgoing.requests).toEqual([
    expect.objectContaining({
      id: requestId,
      recipientAgentId: receiver.id,
      lifetime: "independent",
      followupCount: 0,
      controlsFollowup: true,
    }),
  ]);
  const receiverContext = await messagePromptContext(
    k.db.pool,
    (await k.conversations.read.forAgent(receiver.id)).id,
  );
  expect(receiverContext.incoming.requests.map((r) => r.id)).toEqual([requestId]);
  expect(receiverContext.outgoing.requests).toEqual([]);
  await s.call("send_message", {
    target: { kind: "followup", id: requestId },
    kind: "update",
    message: "Additional evidence",
  });
  expect(
    (await messagePromptContext(k.db.pool, s.run.subject_id)).outgoing.requests[0].followupCount,
  ).toBe(1);
  await k.db.canvas(board, (tx) => settleRequest(tx, requestId, key(), "result"));
  expect(
    (await messagePromptContext(k.db.pool, s.run.subject_id, s.run.frozen_input.workItemId))
      .outgoing.requests[0].state,
  ).toBe("answered");
});

it("shared dependencies identify their followup controller and takeover refreshes ownership", async () => {
  const manager = await agent("admin"),
    source = await agent("admin", manager.id),
    worker = await agent("read", source.id);
  const s = await start(source.id);
  const requestId = (
    await s.call("send_message", {
      target: { kind: "agent", agentId: worker.id },
      kind: "request",
      message: "Continue a dependency",
    })
  ).deliveries[0].requestId;
  const m = await start(manager.id);
  const workerConversation = (await k.conversations.read.forAgent(worker.id)).id;
  await k.db.canvas(board, async (tx) => {
    await retainDependency(tx, m.run.frozen_input.workItemId, requestId);
    for (let i = 0; i < 44; i++)
      await createRequest(tx, {
        canvasId: board,
        messageId: key(),
        sender: { kind: "agent", conversationId: m.run.subject_id, agentId: manager.id },
        recipient: { kind: "agent", conversationId: workerConversation, agentId: worker.id },
      });
  });
  const shared = await messagePromptContext(
    k.db.pool,
    m.run.subject_id,
    m.run.frozen_input.workItemId,
  );
  expect(shared.outgoing).toMatchObject({ total: 45, truncated: true });
  expect(shared.outgoing.requests[0]).toMatchObject({ id: requestId, controlsFollowup: false });
  await k.runs.finish(s.run, "waiting", undefined, "message");
  await m.call("take_over_run", { agentId: source.id, runId: s.run.id });
  const current = await messagePromptContext(
    k.db.pool,
    m.run.subject_id,
    s.run.frozen_input.workItemId,
  );
  expect(current.incoming.requests[0].id).toBe(s.run.frozen_input.workItemId);
  expect(current.outgoing.requests[0]).toMatchObject({ id: requestId, controlsFollowup: true });
  expect((await messagePromptContext(k.db.pool, s.run.subject_id)).outgoing.requests).toEqual([]);
});
