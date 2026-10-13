import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { tickSchedules } from "../../apps/server/dist/modules/work/agent-schedules.js";
import { controlTeams } from "../../apps/server/dist/modules/work/team-controls.js";

const key = () => randomUUID();
const database = `intrica_readiness_${key().replaceAll("-", "")}`;
const token = key(),
  headers = { authorization: `Bearer ${token}` };
let app: Awaited<ReturnType<typeof buildServer>>, k: Kernel, admin: pg.Client, directory: string;
beforeAll(async () => {
  const url = new URL(process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres");
  admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  await admin.query(`create database ${database}`);
  url.pathname = `/${database}`;
  directory = await mkdtemp(join(tmpdir(), "model-readiness-"));
  app = await buildServer({
    databaseUrl: url.href,
    dataDir: directory,
    accessToken: token,
    worker: false,
    model: null,
  });
  await app.ready();
  k = app.kernel;
});
afterAll(async () => {
  await app?.close();
  await admin.query(`drop database if exists ${database} with(force)`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
});
async function scene() {
  const canvas = (await k.graph.createCanvas({ title: "Readiness", idempotencyKey: key() })).node;
  const agent = (
    await k.graph.createNode({
      kind: "agent",
      parentId: canvas.id,
      title: "Draft",
      position: { x: 0, y: 0, width: 200, height: 200 },
      agent: { role: "write", persona: "Draft remains editable", enabled: true },
      idempotencyKey: key(),
    })
  ).node;
  return { canvas, agent };
}
async function profile() {
  const endpoint = await k.models.saveEndpoint({
    name: "Controlled endpoint",
    baseUrl: "http://127.0.0.1:11434/v1",
  });
  return k.models.save({
    endpointId: endpoint.savedId,
    name: "Configured",
    provider: "custom",
    modelId: "test-model",
    api: "openai-completions",
    reasoning: false,
    supportsVision: false,
    thinkingLevel: "off",
  });
}
it("allows draft creation but rejects direct sends, team starts and automatic activation without a model", async () => {
  const { canvas, agent } = await scene();
  expect((await k.models.view()).profiles).toEqual([]);
  for (const agentId of [undefined, agent.id])
    await expect(
      k.conversations.submit({
        canvasId: canvas.id,
        ...(agentId ? { agentId } : {}),
        message: "Should stay unsent",
        key: key(),
      }),
    ).rejects.toMatchObject({ code: "MODEL_NOT_CONFIGURED" });
  await expect(
    controlTeams(k.conversations, [agent.id], "start", key(), "en"),
  ).rejects.toMatchObject({ code: "MODEL_NOT_CONFIGURED" });
  const schedule = key();
  await k.db.pool.query(
    "insert into schedules(id,canvas_id,agent_id,kind,next_due_at,spec,dedupe_key) values($1,$2,$3,'resource_change',now(),'{}',$1)",
    [schedule, canvas.id, agent.id],
  );
  await tickSchedules(k.tools);
  await tickSchedules(k.tools);
  expect(
    (
      await k.db.pool.query(
        "select enabled,dispatch_state,blocked_reason from schedules where id=$1",
        [schedule],
      )
    ).rows[0],
  ).toMatchObject({
    enabled: false,
    dispatch_state: "blocked",
    blocked_reason: "model_not_configured",
  });
  expect((await k.conversations.read.feed(agent.id)).configurationBlocked).toBe(true);
  expect(
    (
      await k.db.pool.query("select count(*)::int as count from runs where canvas_id=$1", [
        canvas.id,
      ])
    ).rows[0].count,
  ).toBe(0);
  const reply = await app.inject({
    method: "POST",
    url: `/api/v2/canvas-agents/${agent.id}/run`,
    headers,
    payload: { message: "API cannot bypass", idempotencyKey: key() },
  });
  expect(reply.statusCode).toBeGreaterThanOrEqual(400);
  expect(reply.json().error.code).toBe("MODEL_NOT_CONFIGURED");
});
it("honors an Agent override without a default and refuses deleted or legacy selections", async () => {
  const { canvas, agent } = await scene();
  const saved = await profile();
  expect((await k.models.view()).selectedId).toBeNull();
  await k.db.pool.query("update agent_configs set config=config||$2::jsonb where node_id=$1", [
    agent.id,
    JSON.stringify({ model: { profileId: saved.savedId } }),
  ]);
  const submitted = await k.conversations.submit({
    canvasId: canvas.id,
    agentId: agent.id,
    message: "Use independent model",
    key: key(),
  });
  expect(submitted.run.frozen_input.model.profileId).toBe(saved.savedId);
  await k.models.delete(
    saved.savedId,
    saved.profiles.find((p) => p.id === saved.savedId)!.revision,
  );
  await expect(
    k.conversations.submit({
      canvasId: canvas.id,
      agentId: agent.id,
      message: "Deleted model",
      key: key(),
    }),
  ).rejects.toMatchObject({ code: "MODEL_NOT_CONFIGURED" });
  await k.db.pool.query(
    'insert into model_profiles(id,public_config,selected) values(\'legacy-mock\',\'{"kind":"mock","name":"Mock model"}\',true)',
  );
  await expect(k.models.capture()).rejects.toMatchObject({ code: "MODEL_NOT_CONFIGURED" });
  expect(
    JSON.stringify((await app.inject({ url: "/api/v2/workspace/models", headers })).json()),
  ).not.toContain("Mock");
  await k.models.initialize();
  expect((await k.models.view()).selectedId).toBeNull();
  expect(
    (await k.conversations.read.history(submitted.conversationId)).some(
      (m) => m.content.text === "Use independent model",
    ),
  ).toBe(true);
  await expect(
    k.models.materialize({ config: { kind: "mock", streamDelayMs: 0, supportsVision: false } }),
  ).rejects.toMatchObject({ code: "MODEL_NOT_CONFIGURED" });
});
