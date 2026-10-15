import { expect, it } from "vitest";
import { createCanvasAgent } from "../../apps/server/dist/adapters/model/agent.js";
import { ModelQueue } from "../../apps/server/dist/modules/model-runtime/queue.js";
import { agent, k, key, start } from "./helpers/runtime-redesign.js";

it("shares admission across 14 conversations and purposes with a quota of ten", async () => {
  const group = `test-${key()}`;
  await k.db.pool.query("insert into model_quota_groups(id,capacity) values($1,10)", [group]);
  const queues = Array.from(
    { length: 14 },
    (_, i) =>
      new ModelQueue(k.db, {
        id: `request-${key()}`,
        conversationId: `c${i}`,
        purpose: i % 2 ? "conversation" : "compaction",
        endpointId: group,
        endpointKey: group,
        sourceHash: `h${i}`,
      }),
  );
  for (const q of queues) await q.initialize();
  const leases = [];
  for (const q of queues) {
    const result = await q.admit(group);
    if (result.owner) leases.push({ q, owner: result.owner });
  }
  expect(leases).toHaveLength(10);
  expect(
    Number(
      (
        await k.db.pool.query(
          "select count(*) from model_requests where group_id=$1 and state='leased'",
          [group],
        )
      ).rows[0].count,
    ),
  ).toBe(10);
  for (const { q, owner } of leases)
    await q.succeed(owner, { role: "assistant", content: [], stopReason: "stop" } as any);
  const rest = [];
  for (const q of queues.slice(10)) {
    const result = await q.admit(group);
    if (result.owner) rest.push(result.owner);
  }
  expect(rest).toHaveLength(4);
  expect((await queues[0]!.admit(group)).row.state).toBe("succeeded");
});

it("rejects late request owners and quarantines cancelled upstream slots", async () => {
  const group = `test-${key()}`,
    q = new ModelQueue(k.db, {
      id: key(),
      conversationId: key(),
      purpose: "compaction",
      endpointId: group,
      endpointKey: group,
      sourceHash: "frozen",
    });
  await q.initialize();
  const old = (await q.admit(group)).owner!;
  await k.db.pool.query(
    "update model_requests set lease_until=now()-interval '1 second' where id=$1",
    [q.request.id],
  );
  const current = (await q.admit(group)).owner!;
  expect(current).not.toBe(old);
  await expect(q.succeed(old, {} as any)).rejects.toMatchObject({ code: "MODEL_LEASE_LOST" });
  await q.cancel(current);
  expect(
    (
      await k.db.pool.query(
        "select state,lease_until>now() as holds_slot from model_requests where id=$1",
        [q.request.id],
      )
    ).rows[0],
  ).toMatchObject({ state: "cancelled", holds_slot: true });
});

it("retries an overloaded provider through one durable request and reuses the saved response", async () => {
  const { createServer } = await import("node:http");
  const { withModelUsage } = await import("../../apps/server/dist/adapters/model/usage.js");
  let attempts = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    expect(JSON.stringify(body.messages)).toContain("original requirement");
    if (++attempts === 1) {
      res.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
      res.end(
        JSON.stringify({
          error: { code: "engine_overloaded", message: "engine_overloaded PRIVATE_PROVIDER_TEXT" },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ id: "test-response", object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta: { role: "assistant", content: "Verified result" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const config = {
    kind: "pi" as const,
    provider: "custom",
    modelId: "test",
    api: "openai-completions" as const,
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    apiKey: "test-key",
    thinkingLevel: "off" as const,
  };
  const identity = {
    db: k.db,
    purpose: "conversation",
    model: { config },
    requestId: key(),
    conversationId: key(),
  };
  try {
    const run = () =>
      withModelUsage(identity, () => createCanvasAgent(config).prompt("original requirement"));
    expect((await run()).content).toEqual([{ type: "text", text: "Verified result" }]);
    expect((await run()).content).toEqual([{ type: "text", text: "Verified result" }]);
    expect(attempts).toBe(2);
    const rows = (
      await k.db.pool.query("select * from model_requests where conversation_id=$1", [
        identity.conversationId,
      ])
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "succeeded", attempts: 2 });
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_PROVIDER_TEXT");
    expect(
      Number(
        (
          await k.db.pool.query("select count(*) from model_calls where request_id=$1", [
            rows[0].id,
          ])
        ).rows[0].count,
      ),
    ).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

it("fences obsolete model owners and removes superseded queued work", async () => {
  const s = await start((await agent()).id),
    group = `fence-${key()}`;
  const identity = {
    runId: s.run.id,
    runEpoch: s.run.epoch,
    conversationId: s.run.subject_id,
    purpose: "conversation",
    endpointId: group,
    endpointKey: group,
  };
  const old = new ModelQueue(k.db, { ...identity, id: key(), sourceHash: "before" });
  await old.initialize();
  const owner = (await old.admit(group)).owner!;
  const next = new ModelQueue(k.db, { ...identity, id: key(), sourceHash: "after" });
  await next.initialize();
  expect((await old.admit(group)).row.state).toBe("cancelled");
  await expect(old.succeed(owner, {} as any)).rejects.toMatchObject({ code: "MODEL_LEASE_LOST" });
  const active = (await next.admit(group)).owner!;
  expect(active).toBeTruthy();
  await k.db.pool.query("update runs set epoch=epoch+1 where id=$1", [s.run.id]);
  await next.cancel(active);
  expect(
    (await k.db.pool.query("select state from model_requests where id=$1", [next.request.id]))
      .rows[0].state,
  ).toBe("leased");
  await expect(next.succeed(active, {} as any)).rejects.toMatchObject({ code: "MODEL_LEASE_LOST" });
});

it("bounds actual provider concurrency for fourteen Agents sharing quota ten, including overload recovery", async () => {
  const { createServer } = await import("node:http");
  const { setTimeout: delay } = await import("node:timers/promises");
  const { withModelUsage } = await import("../../apps/server/dist/adapters/model/usage.js");
  let active = 0,
    peak = 0,
    overloaded = false;
  const served = new Set<string>();
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const goal = JSON.stringify(body.messages).match(/goal-\d+/)![0];
    active++;
    peak = Math.max(peak, active);
    await delay(100);
    if (!overloaded) {
      overloaded = true;
      res.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
      res.end(JSON.stringify({ error: { message: "engine_overloaded" } }));
    } else {
      served.add(goal);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ id: key(), object: "chat.completion.chunk", model: "shared", choices: [{ index: 0, delta: { role: "assistant", content: goal }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    }
    active--;
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(provider.address() as any).port}/v1`,
    group = `stress-${key()}`;
  await k.db.pool.query("insert into model_quota_groups(id,capacity) values($1,10)", [group]);
  await k.db.pool.query(
    "insert into model_endpoints(id,name,base_url,credential_ref,quota_group_id) values($1,'Isolated quota test',$2,'',$1)",
    [group, baseUrl],
  );
  const config = {
    kind: "pi" as const,
    provider: "custom",
    modelId: "shared",
    api: "openai-completions" as const,
    baseUrl,
    apiKey: "test",
    thinkingLevel: "off" as const,
  };
  const sessions = [];
  for (let i = 0; i < 14; i++) sessions.push(await start((await agent()).id));
  try {
    const results = await Promise.all(
      sessions.map((s, i) =>
        withModelUsage(
          {
            db: k.db,
            purpose: i % 2 ? "conversation" : "compaction",
            model: { config, endpointId: group },
            runId: s.run.id,
            runEpoch: s.run.epoch,
            conversationId: s.run.subject_id,
          },
          () => createCanvasAgent(config).prompt(`goal-${i}`),
        ),
      ),
    );
    expect(peak).toBeLessThanOrEqual(10);
    expect(peak).toBeGreaterThan(1);
    expect(served.size).toBe(14);
    expect(results.map((r) => (r.content[0] as { text: string }).text)).toEqual(
      sessions.map((_, i) => `goal-${i}`),
    );
    const rows = (
      await k.db.pool.query("select state,attempts from model_requests where group_id=$1", [group])
    ).rows;
    expect(rows).toHaveLength(14);
    expect(rows.every((r) => r.state === "succeeded")).toBe(true);
    expect(rows.reduce((n, r) => n + r.attempts, 0)).toBe(15);
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((r) => provider.close(() => r()));
  }
});
