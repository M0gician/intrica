import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentConfig, Node, UpdateNodeRequest } from "@intrica/contracts";
import { buildServer, DomainError, type Kernel } from "@intrica/server";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { ModelRegistry } from "../../apps/server/dist/adapters/model/registry.js";
import { Database } from "../../apps/server/dist/adapters/postgres/database.js";
import { DEFAULT_LIMITS } from "../../apps/server/dist/modules/execution/limits.js";
import { resourceResponse } from "../../apps/server/dist/modules/execution/schedules.js";
import { tickSchedules } from "../../apps/server/dist/modules/work/agent-schedules.js";
import { retryResourceResponse } from "../../apps/server/dist/modules/work/resource-response.js";

const key = () => randomUUID();
const name = `intrica_responses_${key().replaceAll("-", "")}`;
const adminUrl = process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres";
const token = key(),
  headers = { authorization: `Bearer ${token}` };
let app: Awaited<ReturnType<typeof buildServer>>,
  k: Kernel,
  dir: string,
  admin: pg.Client,
  board: string,
  databaseUrl: string;
const rect = { x: 0, y: 0, width: 220, height: 300 };
beforeAll(async () => {
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  dir = await mkdtemp(join(tmpdir(), "intrica-responses-"));
  databaseUrl = url.href;
  await openServer();
});
async function openServer() {
  app = await buildServer({
    databaseUrl,
    dataDir: dir,
    accessToken: token,
    worker: false,
    model: { kind: "mock", streamDelayMs: 0, supportsVision: false },
    execution: { ...DEFAULT_LIMITS, collaborationActivations: 3 },
  });
  await app.ready();
  k = app.kernel;
}
beforeEach(async () => {
  board = (await k.graph.createCanvas({ title: "Resource responses", idempotencyKey: key() })).node
    .id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await k.db.pool.query(
    "update runs set state='cancelled',cancel_requested_at=now() where state in('queued','running','waiting')",
  );
  await k.db.pool.query("update schedules set enabled=false,dispatch_state='cancelled'");
  await k.db.pool.query("update model_profiles set selected=false");
  const settings = await k.runs.settings.read();
  await k.runs.settings.save(settings.revision, {
    ...settings.policy,
    pendingPerCanvas: DEFAULT_LIMITS.pendingPerCanvas,
  });
});
afterAll(async () => {
  await app?.close();
  await admin.query(`drop database if exists ${name} with(force)`);
  await admin.end();
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function agent(parentId = board, enabled = true) {
  return (
    await k.graph.createNode({
      kind: "agent",
      parentId,
      title: key(),
      position: rect,
      agent: { role: "write", enabled, persona: "Review resource changes" },
      idempotencyKey: key(),
    })
  ).node;
}
async function resource(kind: "text" | "pdf" | "image" | "todo" = "text", parentId = board) {
  const asset =
    kind === "pdf"
      ? await k.assets.put(
          (await import(new URL("../fixtures/pdf.mjs", import.meta.url).href)).PDF_FIXTURE,
        )
      : undefined;
  return (
    await k.graph.createNode({
      kind,
      parentId,
      ...(asset ? { assetId: asset.assetId } : {}),
      title: key(),
      position: rect,
      idempotencyKey: key(),
    })
  ).node;
}
async function change(node: Node, patch: Partial<UpdateNodeRequest>) {
  const fresh = await k.graph.queries.node(node.id);
  return (
    await k.graph.updateNode(node.id, {
      ...patch,
      expectedRevision: fresh.revision,
      idempotencyKey: key(),
    })
  ).node;
}
async function config(node: Node, patch: Partial<AgentConfig>) {
  const fresh = await k.graph.queries.node(node.id);
  return change(fresh, { agent: { ...fresh.agent!, ...patch } });
}
const link = (a: Node, r: Node) =>
  k.graph.createLink({ fromId: a.id, toId: r.id, idempotencyKey: key() });
const schedule = async (a: Node) =>
  (
    await k.db.pool.query("select * from schedules where agent_id=$1 and kind='resource_change'", [
      a.id,
    ])
  ).rows[0];
const feed = (a: Node) => k.conversations.read.feed(a.id);
const triggers = async (a: Node) =>
  (
    await k.db.pool.query(
      "select m.* from messages m join conversations c on c.id=m.conversation_id where c.agent_id=$1 and m.role='trigger' order by m.seq",
      [a.id],
    )
  ).rows;
async function due(a: Node) {
  await k.db.pool.query(
    "update schedules set next_due_at=clock_timestamp()-interval '1 second' where agent_id=$1",
    [a.id],
  );
}
async function scene() {
  const a = await agent(),
    r = await resource();
  await link(a, r);
  await change(r, { summary: key() });
  return { a, r };
}
async function deliver(a: Node) {
  await due(a);
  await Promise.all([tickSchedules(k.tools), tickSchedules(k.tools)]);
}
async function retry(a: Node, revision?: string, requestKey = key()) {
  return retryResourceResponse(k.db, a.id, revision ?? (await schedule(a)).revision, requestKey);
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error("Database synchronization barrier was not reached");
}
async function modelProfile() {
  const endpoint = await k.models.saveEndpoint({
    name: "fixture",
    baseUrl: "http://127.0.0.1:11434/v1",
  });
  const model = await k.models.save({
    endpointId: endpoint.savedId,
    name: "fixture",
    provider: "custom",
    modelId: "fixture",
    api: "openai-completions",
    reasoning: false,
    supportsVision: false,
    thinkingLevel: "off",
  });
  return model.savedId;
}
async function withoutModel() {
  // Real configuration capture without the test-only mock fallback; no provider requests.
  const models = new ModelRegistry(k.db, dir, null);
  return vi
    .spyOn(k.models, "capture")
    .mockImplementation((selection, sql) => models.capture(selection, sql));
}

it.each([
  ["pdf", { summary: "document outline" }],
  ["text", { summary: "document overview" }],
  ["text", { text: "body evidence" }],
  ["image", { alt: "image description" }],
  ["todo", { todo: { completed: true } }],
] as const)("schedules changed %s content and consumes it once", async (kind, patch) => {
  const a = await agent(),
    r = await resource(kind);
  await link(a, r);
  await change(r, patch);
  expect((await feed(a)).resourceResponse).toMatchObject({ state: "pending", canRetry: false });
  await change(r, patch);
  const pending = await schedule(a);
  await change(r, { title: "Cosmetic title" });
  const fresh = await k.graph.queries.node(r.id);
  await k.graph.submitMove({
    targetParentId: board,
    moves: [{ nodeId: r.id, x: 123, y: 456, expectedLayoutVersion: fresh.layoutVersion }],
    idempotencyKey: key(),
  });
  expect((await schedule(a)).next_due_at).toEqual(pending.next_due_at);
  expect((await schedule(a)).revision).toEqual(pending.revision);
  await deliver(a);
  expect(await triggers(a)).toHaveLength(1);
  expect((await feed(a)).resourceResponse).toMatchObject({ state: "queued", canRetry: false });
  const lease = (await k.runs.claim("resource-test"))!;
  expect(lease.frozen_input.agentId).toBe(a.id);
  await k.conversations.execute(
    { run: lease, store: k.runs, signal: new AbortController().signal, progress() {} },
    (ctx, input) => k.tools.create(ctx, input),
  );
  expect((await feed(a)).resourceResponse).toMatchObject({ state: "consumed", canRetry: false });
  await tickSchedules(k.tools);
  expect(await triggers(a)).toHaveLength(1);
});

it("uses direct and nested grants, cancels revoked access, and coalesces multiple summaries", async () => {
  const group = await resource("text"),
    nested = await resource("text", group.id);
  const direct = await agent(),
    inherited = await agent(),
    off = await agent(board, false),
    revoked = await agent();
  await link(direct, nested);
  await link(inherited, group);
  await link(off, nested);
  const edge = (await link(revoked, group)).edge;
  await change(nested, { summary: key() });
  await k.graph.deleteLink(edge.id, { expectedRevision: edge.revision, idempotencyKey: key() });
  const first = await schedule(direct);
  await change(nested, { summary: key() });
  const latest = await schedule(direct);
  expect(Number(latest.revision)).toBeGreaterThan(Number(first.revision));
  expect(latest.next_due_at.getTime()).toBeGreaterThanOrEqual(first.next_due_at.getTime());
  expect(await schedule(off)).toBeUndefined();
  expect((await schedule(revoked)).dispatch_state).toBe("cancelled");
  for (const a of [direct, inherited, revoked, off]) await due(a);
  await Promise.all([tickSchedules(k.tools), tickSchedules(k.tools)]);
  expect(await triggers(direct)).toHaveLength(1);
  expect(await triggers(inherited)).toHaveLength(1);
  expect(await triggers(revoked)).toHaveLength(0);
  expect(await triggers(off)).toHaveLength(0);
});

it.each(["single", "team"] as const)(
  "%s stop survives model recovery and restart, while live blocked work recovers once",
  async (scope) => {
    const parent = await agent(),
      child = await agent(parent.id),
      untouched = await agent(),
      r = await resource();
    for (const a of [parent, child, untouched]) {
      await link(a, r);
    }
    await change(r, { summary: key() });
    const capture = await withoutModel();
    for (const a of [parent, child, untouched]) await due(a);
    await tickSchedules(k.tools);
    for (const a of [parent, child, untouched])
      expect((await feed(a)).resourceResponse?.reason).toBe("model_not_configured");
    if (scope === "team") await k.conversations.controlTeams([parent.id], "stop", key(), "en");
    else {
      await k.conversations.stop(parent.id);
      await k.conversations.stop(child.id);
    }
    const profileId = await modelProfile();
    await k.models.select(profileId, null);
    capture.mockRestore();
    await app.close();
    await openServer();
    await Promise.all([tickSchedules(k.tools), tickSchedules(k.tools)]);
    for (const a of [parent, child]) {
      expect((await feed(a)).resourceResponse).toMatchObject({
        state: "cancelled",
        reason: "stopped",
        canRetry: false,
      });
      expect(await triggers(a)).toHaveLength(0);
    }
    expect(await triggers(untouched)).toHaveLength(1);
    await change(r, { summary: key() });
    await deliver(parent);
    expect(await triggers(parent)).toHaveLength(1);
  },
);

it("Agent model changes recover only live blocked work and never a stopped trigger", async () => {
  const { a, r } = await scene();
  await config(a, { model: { profileId: "missing-profile" } });
  await deliver(a);
  expect((await schedule(a)).blocked_reason).toBe("model_not_configured");
  await k.conversations.stop(a.id);
  await config(a, { model: null });
  await tickSchedules(k.tools);
  expect(await triggers(a)).toHaveLength(0);
  await change(r, { summary: key() });
  await config(a, { model: { profileId: "another-missing-profile" } });
  await deliver(a);
  await config(a, { model: null });
  await Promise.all([tickSchedules(k.tools), tickSchedules(k.tools)]);
  expect(await triggers(a)).toHaveLength(1);
});

it("an Agent's summary edit triggers other readers and retains the actual causal run", async () => {
  const writer = await agent(),
    reader = await agent(),
    r = await resource();
  await link(writer, r);
  await link(reader, r);
  await k.conversations.submit({
    canvasId: board,
    agentId: writer.id,
    message: "Revise the evidence",
    key: key(),
  });
  const lease = (await k.runs.claim("summary-writer"))!;
  await k.graph.updateNode(
    r.id,
    { summary: key(), expectedRevision: r.revision, idempotencyKey: key() },
    { kind: "agent", agentId: writer.id, runId: lease.id, epoch: lease.epoch },
  );
  expect(await schedule(writer)).toBeUndefined();
  expect((await schedule(reader)).spec.causeId).toBe(lease.cause_id);
  await deliver(reader);
  expect(await triggers(reader)).toHaveLength(1);
  expect(
    (await k.db.pool.query("select activation_count from runs where id=$1", [lease.cause_id]))
      .rows[0].activation_count,
  ).toBe(1);
});

it("serializes a stop with global recovery using real canvas locks", async () => {
  const { a } = await scene();
  await withoutModel();
  await deliver(a);
  const blocker = await k.db.pool.connect();
  await blocker.query("begin");
  await blocker.query("select id from canvases where id=$1 for update", [board]);
  const stopping = k.conversations.stop(a.id);
  let recovering: Promise<unknown> | undefined;
  try {
    await until(async () =>
      Boolean(
        (
          await k.db.pool.query(
            "select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query='select * from canvases where id=$1 for update'",
          )
        ).rowCount,
      ),
    );
    recovering = modelProfile();
    await until(
      async () =>
        (
          await k.db.pool.query(
            "select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%canvases%for update%'",
          )
        ).rows.length >= 2,
    );
    await blocker.query("commit");
    await stopping;
    await recovering;
    await tickSchedules(k.tools);
    expect((await feed(a)).resourceResponse).toMatchObject({
      state: "cancelled",
      reason: "stopped",
    });
    expect(await triggers(a)).toHaveLength(0);
  } finally {
    await blocker.query("rollback");
    blocker.release();
    await stopping;
    await recovering;
  }
});

it("keeps timer and active input independent from disabling resource response", async () => {
  const { a } = await scene();
  await config(a, {
    schedule: { enabled: true, cron: "0 9 * * *", timezone: "UTC", prompt: "review" },
  });
  await deliver(a);
  const delivered = await schedule(a);
  await config(a, { enabled: false });
  expect((await schedule(a)).dispatch_state).toBe("delivered");
  expect((await k.runs.get(delivered.delivery_run_id)).cancel_requested_at).toBeNull();
  expect(
    (
      await k.db.pool.query("select enabled from schedules where agent_id=$1 and kind='cron'", [
        a.id,
      ])
    ).rows[0].enabled,
  ).toBe(true);
  await k.conversations.stop(a.id);
  expect((await schedule(a)).dispatch_state).toBe("cancelled");
  expect(
    (
      await k.db.pool.query("select enabled from schedules where agent_id=$1 and kind='cron'", [
        a.id,
      ])
    ).rows[0].enabled,
  ).toBe(true);
});

it("does not turn persona edits into implicit retries of blocked timers", async () => {
  const a = await agent();
  await config(a, {
    schedule: { enabled: true, cron: "0 9 * * *", timezone: "UTC", prompt: "review" },
  });
  await withoutModel();
  await due(a);
  await tickSchedules(k.tools);
  const timer = (
    await k.db.pool.query("select * from schedules where agent_id=$1 and kind='cron'", [a.id])
  ).rows[0];
  expect(timer.blocked_reason).toBe("model_not_configured");
  await config(a, { persona: "new role description" });
  expect(
    (await k.db.pool.query("select * from schedules where id=$1", [timer.id])).rows[0],
  ).toEqual(timer);
});

it("deleted canvases cannot fill the due batch and starve active resource responses", async () => {
  const hidden = (await k.graph.createCanvas({ title: "deleted", idempotencyKey: key() })).node.id;
  for (let index = 0; index < 21; index++) {
    const a = await agent(hidden);
    await config(a, {
      schedule: { enabled: true, cron: "0 9 * * *", timezone: "UTC", prompt: "review" },
    });
    await due(a);
  }
  await k.graph.deleteCanvas(hidden, { idempotencyKey: key() });
  const { a } = await scene();
  await due(a);
  await tickSchedules(k.tools);
  expect(await triggers(a)).toHaveLength(1);
});

it.each(["toggle", "stop", "revoke"] as const)(
  "a stale due snapshot cannot overwrite newer work after %s",
  async (action) => {
    const a = await agent(),
      r = await resource();
    const edge = (await link(a, r)).edge;
    await change(r, { summary: key() });
    await due(a);
    const seen = barrier(),
      proceed = barrier();
    const original = k.db.transaction.bind(k.db);
    vi.spyOn(k.db, "transaction").mockImplementationOnce(async (fn) => {
      seen.resolve();
      await proceed.promise;
      return original(fn);
    });
    const ticking = tickSchedules(k.tools);
    try {
      await seen.promise;
      if (action === "toggle") {
        await config(a, { enabled: false });
        await config(a, { enabled: true });
      }
      if (action === "stop") await k.conversations.stop(a.id);
      if (action === "revoke")
        await k.graph.deleteLink(edge.id, {
          expectedRevision: edge.revision,
          idempotencyKey: key(),
        });
      await change(r, { summary: key() });
      const current = await schedule(a);
      proceed.resolve();
      await ticking;
      expect(await schedule(a)).toEqual(current);
      expect(await triggers(a)).toHaveLength(0);
      await deliver(a);
      expect(await triggers(a)).toHaveLength(action === "revoke" ? 0 : 1);
    } finally {
      proceed.resolve();
      await ticking;
    }
  },
);

it.each(["model", "transient"] as const)(
  "an old %s failure cannot survive a newer configuration and resource change",
  async (failure) => {
    const { a, r } = await scene();
    await due(a);
    const captured = barrier(),
      proceed = barrier();
    vi.spyOn(k.models, "capture").mockImplementationOnce(async () => {
      captured.resolve();
      await proceed.promise;
      throw failure === "model"
        ? new DomainError("MODEL_NOT_CONFIGURED", "fixture")
        : new Error("controlled capture failure");
    });
    const ticking = tickSchedules(k.tools);
    let editing: Promise<unknown> | undefined;
    try {
      await captured.promise;
      editing = modelProfile();
      await until(async () =>
        Boolean(
          (
            await k.db.pool.query(
              "select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%pg_advisory_xact_lock(hashtextextended%intrica-model-profiles%'",
            )
          ).rowCount,
        ),
      );
      proceed.resolve();
      await ticking;
      await editing;
      if (failure === "transient")
        expect((await feed(a)).resourceResponse).toMatchObject({
          state: "blocked",
          reason: "retry_pending",
          canRetry: true,
        });
      await change(r, { summary: key() });
      const fresh = await schedule(a);
      expect(fresh).toMatchObject({
        enabled: true,
        dispatch_state: "pending",
        blocked_reason: null,
      });
      await deliver(a);
      expect(await triggers(a)).toHaveLength(1);
    } finally {
      proceed.resolve();
      await ticking;
      await editing;
    }
  },
);

async function withCause(
  a: Node,
  activations: number,
  state: "idle" | "running" | "message" | "approval" = "idle",
) {
  const origin = await agent();
  const root = await k.conversations.submit({
    canvasId: board,
    agentId: origin.id,
    message: "source",
    key: key(),
  });
  await k.db.pool.query("update runs set state='succeeded',activation_count=$2 where id=$1", [
    root.run.id,
    activations,
  ]);
  await k.db.pool.query(
    "update schedules set spec=spec||jsonb_build_object('causeId',$2::text) where agent_id=$1",
    [a.id, root.run.id],
  );
  if (state !== "idle") {
    const submitted = await k.conversations.submit({
      canvasId: board,
      agentId: a.id,
      message: "existing work",
      key: key(),
    });
    await k.db.pool.query("update runs set state=$2,reason=$3 where id=$1", [
      submitted.run.id,
      state === "running" ? "running" : "waiting",
      state === "running" ? null : state,
    ]);
  }
  return root.run.id;
}
it.each([2, 3, 4])(
  "enforces an automatic limit of 3 with source count %i and no ghost input",
  async (count) => {
    const { a, r } = await scene();
    const cause = await withCause(a, count);
    await deliver(a);
    if (count < 3) {
      expect(await triggers(a)).toHaveLength(1);
      expect((await schedule(a)).dispatch_state).toBe("delivered");
    } else {
      expect(await triggers(a)).toHaveLength(0);
      expect((await feed(a)).resourceResponse).toMatchObject({
        state: "blocked",
        reason: "activation_limit",
        canRetry: true,
      });
      await retry(a);
      await tickSchedules(k.tools);
      expect(await triggers(a)).toHaveLength(0);
      const notices = (await feed(a)).events.filter((e) => e.data.category === "resource_response");
      expect(notices).toHaveLength(1);
      const sourceSeq = notices[0]!.data.sourceSeq;
      await change(r, { summary: key() });
      await deliver(a);
      expect(await triggers(a)).toHaveLength(1);
      expect((await feed(a)).events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              sourceSeq,
              causeId: cause,
              reason: "activation_limit",
            }),
          }),
        ]),
      );
    }
    const currentCount = (
      await k.db.pool.query("select activation_count from runs where id=$1", [cause])
    ).rows[0].activation_count;
    expect(currentCount).toBe(count < 3 ? count + 1 : count);
  },
);
it.each(["running", "message", "approval"] as const)(
  "preserves RunStore activation rules for an Agent in %s",
  async (state) => {
    const { a } = await scene();
    const cause = await withCause(a, 3, state);
    await deliver(a);
    expect(await triggers(a)).toHaveLength(state === "running" ? 1 : 0);
    expect((await schedule(a)).dispatch_state).toBe(state === "running" ? "delivered" : "blocked");
    expect(
      (await k.db.pool.query("select activation_count from runs where id=$1", [cause])).rows[0]
        .activation_count,
    ).toBe(3);
  },
);

it("an explicit retry can append to new owner work without resetting the exhausted source budget", async () => {
  const { a } = await scene();
  const cause = await withCause(a, 3);
  await deliver(a);
  const sourceSeq = (await schedule(a)).spec.sourceSeq;
  const work = await k.conversations.submit({
    canvasId: board,
    agentId: a.id,
    message: "Continue reviewing these resources",
    key: key(),
  });
  const revision = (await schedule(a)).revision,
    requestKey = key();
  await retry(a, revision, requestKey);
  await Promise.all([tickSchedules(k.tools), tickSchedules(k.tools)]);
  await retry(a, revision, requestKey);
  const inputs = await triggers(a);
  expect(inputs).toHaveLength(1);
  expect(inputs[0].run_id).toBe(work.run.id);
  expect(inputs[0].content.resourceResponse.sourceSeq).toBe(sourceSeq);
  expect(
    (await k.db.pool.query("select activation_count from runs where id=$1", [cause])).rows[0]
      .activation_count,
  ).toBe(3);
});

it("distinguishes a missing source and queue capacity, persists retry identity, and rejects stale or delivered retries", async () => {
  const { a, r } = await scene();
  await k.db.pool.query(
    'update schedules set spec=spec||\'{"causeId":"missing-source"}\' where agent_id=$1',
    [a.id],
  );
  await deliver(a);
  expect((await feed(a)).resourceResponse?.reason).toBe("source_missing");
  expect(await triggers(a)).toHaveLength(0);
  await change(r, { summary: key() });
  const other = await agent();
  const active = await k.conversations.submit({
    canvasId: board,
    agentId: other.id,
    message: "fill queue",
    key: key(),
  });
  const settings = await k.runs.settings.read();
  await k.runs.settings.save(settings.revision, { ...settings.policy, pendingPerCanvas: 1 });
  await deliver(a);
  const row = await schedule(a);
  expect(row).toMatchObject({
    enabled: true,
    dispatch_state: "blocked",
    blocked_reason: "queue_full",
  });
  expect(await triggers(a)).toHaveLength(0);
  const url = `/api/v2/canvas-agents/${a.id}/resource-response/retry`;
  const payload = { expectedRevision: row.revision, idempotencyKey: key() };
  expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
  const first = await app.inject({ method: "POST", url, headers, payload });
  const replay = await app.inject({ method: "POST", url, headers, payload });
  expect(first.statusCode).toBe(200);
  expect(replay.json()).toEqual(first.json());
  const stale = await app.inject({
    method: "POST",
    url,
    headers,
    payload: { ...payload, idempotencyKey: key() },
  });
  expect(stale.statusCode).toBe(409);
  await k.db.pool.query("update runs set state='succeeded' where id=$1", [active.run.id]);
  await Promise.all([tickSchedules(k.tools), tickSchedules(k.tools)]);
  expect(await triggers(a)).toHaveLength(1);
  await expect(retry(a)).rejects.toMatchObject({ code: "INVALID_STATE" });
  expect(
    (await app.inject({ url: `/api/v2/canvas-agents/${a.id}`, headers })).json().resourceResponse
      .state,
  ).toBe("queued");
  await k.conversations.stop(a.id);
  await expect(retry(a)).rejects.toMatchObject({ code: "INVALID_STATE" });
});

it("uses the current clock after a real canvas lock wait, and delivers only after the last change is stable", async () => {
  const { a, r } = await scene();
  const blocker = await k.db.pool.connect();
  await blocker.query("begin");
  await blocker.query("select id from canvases where id=$1 for update", [board]);
  const saving = change(r, { summary: key() });
  try {
    await until(async () =>
      Boolean(
        (
          await k.db.pool.query(
            "select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query='select * from canvases where id=$1 for update'",
          )
        ).rowCount,
      ),
    );
    await delay(1100);
    await blocker.query("commit");
    await saving;
    const remaining = Number(
      (
        await k.db.pool.query(
          "select extract(epoch from next_due_at-clock_timestamp()) as seconds from schedules where agent_id=$1",
          [a.id],
        )
      ).rows[0].seconds,
    );
    expect(remaining).toBeGreaterThan(9.5);
    expect(remaining).toBeLessThanOrEqual(10);
  } finally {
    await blocker.query("rollback");
    blocker.release();
    await saving;
  }
  // The earlier transaction acquires the lock after a later transaction commits.
  const started = barrier(),
    proceed = barrier();
  const original = k.db.transaction.bind(k.db);
  vi.spyOn(k.db, "transaction").mockImplementationOnce((fn) =>
    original(async (tx) => {
      started.resolve();
      await proceed.promise;
      return fn(tx);
    }),
  );
  const earlier = k.graph.command(board, key(), "node.update", {}, { kind: "owner" }, async (m) => {
    await m.update(r.id, { summary: key() });
    return {};
  });
  try {
    await started.promise;
    await change(r, { summary: key() });
    const before = await schedule(a);
    proceed.resolve();
    await earlier;
    const after = await schedule(a);
    expect(after.next_due_at.getTime()).toBeGreaterThanOrEqual(before.next_due_at.getTime());
    await change(r, { title: "title preserves deadline" });
    expect((await schedule(a)).next_due_at).toEqual(after.next_due_at);
    await tickSchedules(k.tools);
    expect(await triggers(a)).toHaveLength(0);
    const remaining = Math.max(0, after.next_due_at.getTime() - Date.now());
    await delay(remaining + 40);
    await Promise.all([tickSchedules(k.tools), tickSchedules(k.tools)]);
    const delivered = await triggers(a);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].created_at.getTime()).toBeGreaterThanOrEqual(after.next_due_at.getTime());
  } finally {
    proceed.resolve();
    await earlier;
  }
});

it("migrates ambiguous legacy blocks without reviving stopped work", async () => {
  const migrationName = `intrica_responses_migration_${key().replaceAll("-", "")}`;
  await admin.query(`create database ${migrationName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${migrationName}`;
  const db = new Database(url.href);
  try {
    await db.migrate();
    await db.pool.query("insert into canvases(id,title) values('c','migration')");
    for (const agentId of [
      "old-block",
      "old-stop",
      "live",
      "old-read",
      "old-unread",
      "old-discarded",
    ]) {
      await db.pool.query(
        "insert into nodes(id,canvas_id,sort_key,kind,body,x,y,w,h) values($1,'c',1,'agent','{}',0,0,200,200)",
        [agentId],
      );
      await db.pool.query(
        'insert into agent_configs(node_id,config,enabled) values($1,\'{"role":"write","enabled":true}\',true)',
        [agentId],
      );
      await db.pool.query(
        "insert into schedules(id,canvas_id,agent_id,kind,next_due_at,spec,dedupe_key,enabled) values($1,'c',$1,'resource_change',now(),$2,$1,$3)",
        [
          agentId,
          !["old-stop", "live"].includes(agentId)
            ? { blockedReason: "model_not_configured", sourceSeq: "77" }
            : {},
          agentId === "live",
        ],
      );
      await db.pool.query("insert into conversations(id,canvas_id,agent_id) values($1,'c',$1)", [
        agentId,
      ]);
    }
    for (const agentId of ["old-read", "old-unread", "old-discarded"]) {
      const sent = (
        await db.pool.query(
          "update schedules set next_due_at='2026-01-02T03:04:05.123456Z' where id=$1 returning next_due_at",
          [agentId],
        )
      ).rows[0];
      await db.pool.query(
        "update conversations set message_seq=1,consumed_message_seq=$2 where id=$1",
        [agentId, agentId === "old-unread" ? 0 : 1],
      );
      await db.pool.query(
        "insert into messages(conversation_id,seq,client_message_id,role,content,consumed_run_id) values($1,1,$2,'trigger','{}',$3)",
        [
          agentId,
          `schedule-${agentId}-${sent.next_due_at.toISOString()}`,
          agentId === "old-read" ? "previous-run" : null,
        ],
      );
    }
    // Reconstruct the v12 schedules table exactly, then use the real migration runner.
    await db.pool.query(
      "alter table schedules drop column revision, drop column dispatch_state, drop column blocked_reason, drop column delivery_seq, drop column delivery_run_id",
    );
    await db.pool.query(
      "alter table schema_info drop constraint schema_info_version_check; update schema_info set version=12; alter table schema_info add constraint schema_info_version_check check(version=12)",
    );
    await db.migrate();
    const models = new ModelRegistry(db, dir, null);
    await models.initialize();
    const states = (
      await db.pool.query(
        "select id,enabled,dispatch_state,blocked_reason,spec from schedules order by id",
      )
    ).rows;
    expect(states.filter((row) => ["old-block", "old-stop", "live"].includes(row.id))).toEqual([
      { id: "live", enabled: true, dispatch_state: "pending", blocked_reason: null, spec: {} },
      {
        id: "old-block",
        enabled: false,
        dispatch_state: "blocked",
        blocked_reason: "legacy_configuration",
        spec: { sourceSeq: "77" },
      },
      {
        id: "old-stop",
        enabled: false,
        dispatch_state: "cancelled",
        blocked_reason: "legacy_inactive",
        spec: {},
      },
    ]);
    for (const [agentId, state] of [
      ["old-read", "consumed"],
      ["old-unread", "queued"],
      ["old-discarded", "cancelled"],
    ]) {
      expect(await resourceResponse(db.pool, agentId!)).toMatchObject({ state, canRetry: false });
      await expect(retryResourceResponse(db, agentId!, "1", key())).rejects.toMatchObject({
        code: "INVALID_STATE",
      });
    }
  } finally {
    await db.close();
    await admin.query(`drop database if exists ${migrationName} with(force)`);
  }
});
