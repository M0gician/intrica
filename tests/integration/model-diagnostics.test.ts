import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createCanvasAgent } from "../../apps/server/dist/adapters/model/agent.js";
import { pruneModelDiagnostics } from "../../apps/server/dist/adapters/model/diagnostic-policy.js";
import type { ModelConfig } from "../../apps/server/dist/adapters/model/types.js";
import { withModelUsage } from "../../apps/server/dist/adapters/model/usage.js";
import { invokeTool, result } from "../../apps/server/dist/modules/execution/tool-calls.js";
import { conversationTrace } from "../../apps/server/dist/modules/work/trace.js";

const key = () => randomUUID();
const database = `intrica_diagnostics_${key().replaceAll("-", "")}`;
const url = new URL(process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres");
const token = key(),
  headers = { authorization: `Bearer ${token}` };
const endpoints = new Set<Server>();
let admin: pg.Client, app: Awaited<ReturnType<typeof buildServer>>, k: Kernel, directory: string;
beforeAll(async () => {
  admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  await admin.query(`create database ${database}`);
  url.pathname = `/${database}`;
  directory = await mkdtemp(join(tmpdir(), "intrica-diagnostics-"));
  app = await buildServer({
    databaseUrl: url.href,
    dataDir: directory,
    worker: false,
    accessToken: token,
    model: { kind: "mock", streamDelayMs: 0, supportsVision: false },
  });
  await app.ready();
  k = app.kernel;
});
afterEach(async () => {
  for (const endpoint of endpoints) {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  }
  endpoints.clear();
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
async function policy(enabled: boolean) {
  const current = (await app.inject({ url: "/api/v2/settings/model-diagnostics", headers })).json();
  const response = await app.inject({
    method: "PUT",
    url: "/api/v2/settings/model-diagnostics",
    headers,
    payload: { expectedRevision: current.revision, enabled, retentionDays: 1, manifestDays: 2 },
  });
  expect(response.statusCode).toBe(200);
}

it("the real runner parks repeated schema failures, completes independent work, and accepts corrected input", async () => {
  const canvasId = (
    await k.graph.createCanvas({ title: "Independent work", idempotencyKey: key() })
  ).node.id;
  const first = await k.conversations.submit({
    canvasId,
    message: "A task requiring tool input",
    key: key(),
  });
  await k.conversations.submit({
    canvasId,
    conversationId: first.conversationId,
    message: "A separate task",
    key: key(),
  });
  const requests = (
    await k.db.pool.query(
      "select id from message_requests where recipient_conversation_id=$1 order by created_at,id",
      [first.conversationId],
    )
  ).rows;
  const firstId = requests[0].id,
    secondId = requests[1].id;
  let failures = 0,
    corrected = false;
  const endpoint = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw),
      system = body.messages.find((m: any) => m.role === "system").content;
    const current = system.match(/Current work item: (request-[\w-]+)/)?.[1];
    const chunk = (delta: unknown, finish_reason: string | null = null) =>
      `data: ${JSON.stringify({ id: key(), model: "runner-test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (current === firstId && !corrected) {
      failures++;
      res.end(
        chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: key(),
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ target: "invalid-object" }) },
            },
          ],
        }) +
          chunk({}, "tool_calls") +
          "data: [DONE]\n\n",
      );
    } else
      res.end(
        chunk({
          role: "assistant",
          content: JSON.stringify({
            target: { kind: "request", id: current },
            kind: "result",
            message: "Task completed",
          }),
        }) +
          chunk({}, "stop") +
          "data: [DONE]\n\n",
      );
  });
  endpoints.add(endpoint);
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  const config: ModelConfig = {
    kind: "pi",
    provider: "openai",
    api: "openai-completions",
    modelId: "runner-test",
    baseUrl: `http://127.0.0.1:${(endpoint.address() as { port: number }).port}/v1`,
    apiKey: "fixture",
    supportsVision: false,
  };
  await k.db.pool.query(
    "update runs set frozen_input=jsonb_set(frozen_input,'{model}',$2) where id=$1",
    [first.run.id, JSON.stringify({ config })],
  );
  const execute = async () => {
    const run = (await k.runs.claim("runner-test"))!;
    const ctx = { run, store: k.runs, signal: AbortSignal.timeout(15000), progress() {} };
    await withModelUsage(
      {
        db: k.db,
        purpose: "conversation",
        model: { config },
        runId: run.id,
        attemptId: run.attemptId,
        conversationId: run.subject_id,
        canvasId,
      },
      () => k.conversations.execute(ctx, (context, input) => k.tools.create(context, input)),
    );
  };
  await execute();
  expect(failures).toBe(k.runs.limits.toolInputRepairs + 1);
  expect(
    (
      await k.db.pool.query("select state,blocked_reason from message_requests where id=$1", [
        firstId,
      ])
    ).rows[0],
  ).toMatchObject({ state: "open", blocked_reason: "tool_input" });
  expect(
    (await k.db.pool.query("select state from message_requests where id=$1", [secondId])).rows[0]
      .state,
  ).toBe("answered");
  corrected = true;
  await k.conversations.submit({
    canvasId,
    conversationId: first.conversationId,
    message: "Corrected input",
    association: { kind: "append", requestId: firstId },
    key: key(),
  });
  await execute();
  expect(
    (await k.db.pool.query("select state from message_requests where id=$1", [firstId])).rows[0]
      .state,
  ).toBe("answered");
  expect(
    (await conversationTrace(k.db, first.conversationId)).tools.every(
      (t) => t.audit.executed === false,
    ),
  ).toBe(true);
});
async function generate({
  malformed = false,
  pause,
}: {
  malformed?: boolean;
  pause?: () => Promise<void>;
} = {}) {
  const canvasId = (
    await k.graph.createCanvas({ title: "Model diagnostics", idempotencyKey: key() })
  ).node.id;
  await k.conversations.submit({ canvasId, message: "Inspect an example", key: key() });
  const run = (await k.runs.claim("diagnostic-test"))!;
  const generationId = `turn-${key()}`;
  const endpoint = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      if (req.headers.authorization !== "Bearer provider-secret" || !payload.messages?.length)
        throw new Error("Missing provider request input");
      const chunk = (delta: unknown, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ id: "diagnostic-response", model: "diagnostic-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `provider-${key()}`,
              type: "function",
              function: { name: "inspect", arguments: "" },
            },
          ],
        }),
      );
      res.write(
        chunk({
          tool_calls: [
            {
              index: 0,
              function: {
                arguments: malformed
                  ? '{"target":'
                  : JSON.stringify({ target: { id: "evidence" } }),
              },
            },
          ],
        }),
      );
      await pause?.();
      res.end(`${chunk({}, "tool_calls")}data: [DONE]\n\n`);
    } catch {
      if (!res.destroyed) res.writeHead(500).end("Fixture request failed");
    }
  });
  endpoints.add(endpoint);
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  const port = (endpoint.address() as { port: number }).port;
  const config: ModelConfig = {
    kind: "pi",
    provider: "openai",
    modelId: "diagnostic-model",
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "provider-secret",
    supportsVision: false,
  };
  const agent = createCanvasAgent(config, run.id);
  agent.state.tools = [
    {
      name: "inspect",
      label: "inspect",
      description: "Inspect a target",
      parameters: Type.Object({ target: Type.Object({ id: Type.String() }) }),
      execute: async () => result({ done: true }),
    },
  ];
  agent.state.systemPrompt = "Private diagnostic prompt password=prompt-secret";
  agent.state.messages = [
    { role: "user", content: "private request content; provider-secret", timestamp: Date.now() },
  ];
  const pending = withModelUsage(
    {
      db: k.db,
      purpose: "conversation",
      model: { config },
      runId: run.id,
      attemptId: run.attemptId,
      conversationId: run.subject_id,
      canvasId,
      generationId,
    },
    () => agent.turn(),
  );
  void pending.catch(() => {});
  return { run, generationId, pending };
}

it.each([false, true])(
  "records a manifest with controlled diagnostic content: enabled=%s",
  async (enabled) => {
    await policy(enabled);
    const s = await generate({ malformed: true });
    const message = await s.pending;
    const tool = message.content[0] as any;
    expect(tool.argumentError).toContain("valid JSON");
    const execute = vi.fn(async () => result({ done: true }));
    const ctx = { run: s.run, store: k.runs, signal: new AbortController().signal, progress() {} };
    await invokeTool(
      ctx,
      {
        name: "inspect",
        label: "inspect",
        description: "Inspect",
        effect: "read",
        parameters: Type.Object({ target: Type.Object({ id: Type.String() }) }),
        execute,
      },
      `${s.generationId}:${tool.id}`,
      tool.arguments,
      undefined,
      undefined,
      undefined,
      {
        generationId: s.generationId,
        providerCallId: tool.id,
        contentIndex: 0,
        observationId: tool.observationId,
        parseError: tool.argumentError,
      },
    );
    expect(execute).not.toHaveBeenCalled();
    const trace = await conversationTrace(k.db, s.run.subject_id);
    expect(trace.tools).toHaveLength(1);
    expect(trace.observations).toHaveLength(1);
    expect(trace.requests).toHaveLength(1);
    expect(trace.tools[0]).toMatchObject({
      observation_id: trace.observations[0].id,
      model_call_id: trace.models[0].id,
      audit: { phase: "parse", executed: false },
    });
    expect(trace.models[0].manifest).toMatchObject({
      version: 1,
      source: "adapter_context",
      diagnosticModeAtStart: enabled ? "redacted" : "metadata",
    });
    expect(trace.models[0].diagnostics).toBeNull();
    expect(JSON.stringify(trace)).not.toContain("private request content");
    const exported = (
      await app.inject({ url: `/api/v2/conversations/${s.run.subject_id}/trace/export`, headers })
    ).json();
    expect(exported.models[0].diagnostics !== null).toBe(enabled);
    if (enabled) {
      expect(JSON.stringify(exported)).toContain("private request content");
      expect(exported.observations[0].diagnostics.source).toBe("provider_argument_deltas");
    }
    for (const secret of ["provider-secret", "prompt-secret"])
      expect(JSON.stringify(exported)).not.toContain(secret);
    await k.db.pool.query(
      "update model_calls set diagnostics_expires_at=now()-interval '1 second',manifest_expires_at=now()-interval '1 second' where id=$1",
      [trace.models[0].id],
    );
    await pruneModelDiagnostics(k.db);
    const expired = await conversationTrace(k.db, s.run.subject_id, true);
    expect(expired.models[0].diagnostics).toBeNull();
    expect(expired.models[0].manifest.expired).toBe(true);
    expect(expired.observations[0].diagnostics).toBeNull();
  },
);

it("clearing debug content fences late provider output and preserves invocation metadata", async () => {
  await policy(true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const s = await generate({ pause: () => gate });
  await expect
    .poll(
      async () =>
        (
          await k.db.pool.query(
            "select count(*)::int as count from model_tool_observations o join model_calls c on c.id=o.model_call_id where c.run_id=$1",
            [s.run.id],
          )
        ).rows[0].count,
    )
    .toBe(1);
  const cleared = await app.inject({
    method: "DELETE",
    url: "/api/v2/settings/model-diagnostics/content",
    headers,
  });
  expect(cleared.statusCode).toBe(200);
  release();
  await s.pending;
  const trace = await conversationTrace(k.db, s.run.subject_id, true);
  expect(trace.models).toHaveLength(1);
  expect(trace.observations).toHaveLength(1);
  expect(trace.models[0].diagnostics).toBeNull();
  expect(trace.observations[0].diagnostics).toBeNull();
});
