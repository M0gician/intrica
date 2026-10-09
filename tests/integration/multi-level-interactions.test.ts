import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRole, Node } from "@intrica/contracts";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { grantsFor, managementChain } from "../../apps/server/dist/modules/access/policy.js";
import { invokeTool } from "../../apps/server/dist/modules/execution/tool-calls.js";

// The model is not the oracle: every assertion inspects production authorization,
// durable calls/messages, actual host reads or graph state across a four-level team.
const key = () => randomUUID();
const dbName = `intrica_multi_level_${key().replaceAll("-", "")}`;
let app: Awaited<ReturnType<typeof buildServer>>, k: Kernel, dir: string, area: string;
let admin: pg.Client, board: string;

beforeAll(async () => {
  const adminUrl = process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres";
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  dir = await realpath(await mkdtemp(join(tmpdir(), "intrica-multi-level-data-")));
  area = await realpath(await mkdtemp(join(tmpdir(), "intrica-multi-level-files-")));
  app = await buildServer({
    databaseUrl: url.href,
    dataDir: dir,
    accessToken: key(),
    worker: false,
    model: { kind: "mock", streamDelayMs: 0, supportsVision: false },
  });
  await app.ready();
  k = app.kernel;
});
beforeEach(async () => {
  board = (await k.graph.createCanvas({ title: "four-level team", idempotencyKey: key() })).node.id;
});
afterEach(async () => {
  await k.db.pool.query("update conversations set consumed_message_seq=message_seq");
  await k.db.pool.query("update schedules set enabled=false");
  await k.db.pool.query("update approvals set status='cancelled' where status='pending'");
  await k.db.pool.query(
    "update runs set state='cancelled',cancel_requested_at=now() where state in('queued','running','waiting')",
  );
});
afterAll(async () => {
  await app?.close();
  await admin.query(`drop database if exists ${dbName} with(force)`);
  await admin.end();
  if (dir) await rm(dir, { recursive: true, force: true });
  if (area) await rm(area, { recursive: true, force: true });
});

const rect = { x: 0, y: 0, width: 220, height: 300 };
const agent = async (parentId = board, role: AgentRole = "admin") =>
  (
    await k.graph.createNode({
      kind: "agent",
      parentId,
      title: key(),
      agent: { role, enabled: false, persona: "" },
      position: rect,
      idempotencyKey: key(),
    })
  ).node;
const resource = async (parentId = board, path?: string) =>
  (
    await k.graph.createNode({
      kind: "text",
      parentId,
      title: "evidence",
      text: "source evidence",
      ...(path ? { resource: { type: "directory" as const, path } } : {}),
      position: rect,
      idempotencyKey: key(),
    })
  ).node;
const connect = (subject: Node, target: Node) =>
  k.graph.createLink({ fromId: subject.id, toId: target.id, idempotencyKey: key() });
async function tree() {
  const top = await agent(),
    division = await agent(top.id),
    lead = await agent(division.id),
    worker = await agent(lead.id, "write");
  return { top, division, lead, worker };
}
async function start(a: Node) {
  const submitted = await k.conversations.submit({
    canvasId: a.canvasId!,
    agentId: a.id,
    message: "begin assigned work",
    key: key(),
  });
  const run = (await k.runs.claim("multi-level-test"))!;
  expect(run.id).toBe(submitted.run.id);
  const ctx = { run, store: k.runs, signal: new AbortController().signal, progress() {} };
  const tools = await k.tools.create(ctx, run.frozen_input);
  return {
    run,
    ctx,
    actor: { kind: "agent" as const, agentId: a.id, runId: run.id, epoch: run.epoch },
    async call(name: string, args: object, logical: string = key()) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `registered tool ${name}`).toBeDefined();
      const response = await invokeTool(ctx, tool!, logical, args);
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
type Session = Awaited<ReturnType<typeof start>>;
async function request(id: string) {
  return (await k.db.pool.query("select * from approvals where id=$1", [id])).rows[0];
}
async function decide(
  id: string,
  reviewer?: Session,
  decision: "approve" | "deny" | "escalate" = "approve",
) {
  return k.access.decide(id, (await request(id)).version, decision, "reviewed", reviewer?.actor);
}
async function incoming(a: Node) {
  return (
    await k.db.pool.query(
      "select m.* from messages m join conversations c on c.id=m.conversation_id where c.agent_id=$1 and m.role='message' and m.content ? 'from' order by m.seq",
      [a.id],
    )
  ).rows;
}
async function history(a: Node) {
  return k.conversations.read.history((await k.conversations.read.forAgent(a.id)).id);
}
async function scope(a: Node) {
  return (await grantsFor(k.db.pool, a.id)).map((g) => `${g.resource_id}:${g.mode}`).sort();
}

it("M01 four-level cross-branch coordination preserves recipients, roles and disjoint tool scopes", async () => {
  const { top, division, lead, worker } = await tree(),
    otherDivision = await agent(top.id),
    otherLead = await agent(otherDivision.id),
    cousin = await agent(otherLead.id, "read"),
    left = await resource(),
    right = await resource();
  await connect(top, left);
  await connect(top, right);
  await connect(lead, left);
  await connect(worker, left);
  await connect(cousin, right);
  const child = await start(worker),
    peer = await start(cousin),
    before = await Promise.all([scope(worker), scope(cousin)]);
  expect(await managementChain(k.db.pool, worker.id)).toEqual([lead.id, division.id, top.id]);
  const args = {
    target: { kind: "agent", agentId: cousin.id },
    message: "inspect your branch, not my files",
  };
  const sent = await child.call("send_message", args, "cross-branch-once");
  expect(sent.waiting).toBeUndefined();
  expect(sent.value.recipients).toEqual([cousin.id]);
  expect((await child.call("send_message", args, "cross-branch-once")).value).toEqual(sent.value);
  expect((await incoming(cousin)).map((m) => m.content.text)).toEqual([args.message]);
  expect(
    (
      await peer.call("send_message", {
        target: { kind: "agent", agentId: worker.id },
        message: "branch checked",
      })
    ).value.delivered,
  ).toBe(1);
  expect(
    (await child.call("report_result", { message: "direct result" })).value.recipients,
  ).toEqual([lead.id]);
  expect(await incoming(top)).toHaveLength(0);
  expect(await incoming(division)).toHaveLength(0);
  expect(await Promise.all([scope(worker), scope(cousin)])).toEqual(before);
  expect((await k.graph.queries.node(cousin.id)).agent!.role).toBe("read");
  expect((await k.access.list(board, { status: "pending" })).total).toBe(0);
});

it("M02 one private leaf resource blocks cross-branch delivery despite a common admin ancestor", async () => {
  const { top, worker } = await tree(),
    otherDivision = await agent(top.id),
    cousin = await agent(otherDivision.id, "write"),
    publicResource = await resource(),
    privateResource = await resource();
  for (const a of [top, worker, cousin]) await connect(a, publicResource);
  await connect(worker, privateResource);
  const sender = await start(worker),
    args = { target: { kind: "agent", agentId: cousin.id }, message: "must remain private" };
  const pending = await sender.call("send_message", args, "private-branch-once");
  expect(pending.waiting).toBe("approval");
  expect(await incoming(cousin)).toHaveLength(0);
  await decide(pending.value.requestId, undefined, "deny");
  const denied = await sender.call("send_message", args, pending.logical);
  expect(denied.result.isError).toBe(true);
  expect((await request(pending.value.requestId)).status).toBe("denied");
  expect(await incoming(cousin)).toHaveLength(0);
  expect((await history(worker)).filter((m) => m.role === "message")).toHaveLength(0);
  expect(await scope(cousin)).not.toContain(`${privateResource.id}:write`);
});

it("M03 three review hops retain one frozen call and user steering, then execute only the approved path", async () => {
  const { top, division, lead, worker } = await tree(),
    directory = await resource(board, area);
  await connect(top, directory);
  await writeFile(join(area, "four-level.txt"), "approved through three managers");
  const director = await start(top),
    divisionManager = await start(division),
    manager = await start(lead),
    child = await start(worker);
  const args = {
      scope: { kind: "path", path: area, access: "directory", mode: "read", execution: "none" },
      reason: "read assigned evidence",
    },
    pending = await child.call("request_permission", args, "three-hop-request");
  expect(pending.waiting).toBe("approval");
  const original = await request(pending.value.requestId);
  expect(original.assigned_reviewer_id).toBe(lead.id);
  await k.conversations.submit({
    canvasId: board,
    agentId: worker.id,
    message: "wait for approved evidence before the final report",
    key: key(),
  });
  for (const [reviewer, next] of [
    [manager, division],
    [divisionManager, top],
  ] as const) {
    const before = await request(original.id);
    await expect(decide(original.id, reviewer)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await decide(original.id, reviewer, "escalate");
    expect((await request(original.id)).assigned_reviewer_id).toBe(next.id);
    await expect(
      k.access.decide(original.id, before.version, "approve", "stale review", reviewer.actor),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  }
  await decide(original.id, director);
  expect((await child.call("request_permission", args, pending.logical)).value.status).toBe(
    "granted",
  );
  expect(
    (await child.call("read", { target: { kind: "path", path: join(area, "four-level.txt") } }))
      .value.text,
  ).toBe("approved through three managers");
  expect(
    (await history(worker)).filter(
      (m) =>
        m.role === "user" &&
        m.content.text === "wait for approved evidence before the final report",
    ),
  ).toHaveLength(1);
  expect(
    (
      await k.db.pool.query(
        "select * from tool_calls where run_id=$1 and name='request_permission'",
        [child.run.id],
      )
    ).rows,
  ).toHaveLength(1);
  expect(await scope(division)).toEqual([]);
  expect(await scope(lead)).toEqual([]);
  expect((await k.graph.queries.node(worker.id)).agent!.role).toBe("write");
  await k.conversations.execute(child.ctx, (ctx, input) => k.tools.create(ctx, input));
  expect((await k.runs.get(child.run.id)).state).toBe("succeeded");
  const conversation = (
    await k.db.pool.query(
      "select checkpoint,consumed_message_seq from conversations where agent_id=$1",
      [worker.id],
    )
  ).rows[0];
  expect(JSON.stringify(conversation.checkpoint)).toContain(
    "wait for approved evidence before the final report",
  );
  const steering = (await history(worker)).find(
    (m) =>
      m.role === "user" && m.content.text === "wait for approved evidence before the final report",
  )!;
  expect(Number(conversation.consumed_message_seq)).toBeGreaterThanOrEqual(Number(steering.seq));
  expect(
    (
      await k.db.pool.query(
        "select * from tool_calls where run_id=$1 and name='request_permission'",
        [child.run.id],
      )
    ).rows,
  ).toHaveLength(1);
});

it.each(["move-middle", "revoke-root", "downgrade-root"] as const)(
  "M04 %s revokes a four-level delegation chain but preserves the leaf's independent owner grant",
  async (mutation) => {
    const { top, division, lead, worker } = await tree(),
      outside = await agent(),
      evidence = await resource(),
      edge = await connect(top, evidence);
    const director = await start(top),
      divisionManager = await start(division),
      manager = await start(lead),
      child = await start(worker);
    for (const [member, reviewer, mode] of [
      [divisionManager, director, "write"],
      [manager, divisionManager, "write"],
      [child, manager, "read"],
    ] as const) {
      const pending = await member.call("request_permission", {
        scope: { kind: "resource", nodeId: evidence.id, mode },
        reason: "narrow delegation",
      });
      expect(pending.waiting).toBe("approval");
      await decide(pending.value.requestId, reviewer);
    }
    await connect(worker, evidence);
    const independent = await scope(worker);
    expect(independent).toHaveLength(2);
    if (mutation === "move-middle") {
      await k.graph.submitMove({
        targetParentId: outside.id,
        moves: [{ nodeId: division.id, x: 10, y: 10 }],
        idempotencyKey: key(),
      });
    } else if (mutation === "revoke-root") {
      await k.graph.deleteLink(edge.edge.id, { idempotencyKey: key() });
    } else {
      await k.graph.updateNode(top.id, {
        expectedRevision: top.revision,
        agent: { ...top.agent!, role: "read" },
        idempotencyKey: key(),
      });
    }
    expect(await scope(division)).toEqual([]);
    expect(await scope(lead)).toEqual([]);
    expect(await scope(worker)).toEqual([`${evidence.id}:write`]);
    expect((await k.runs.get(divisionManager.run.id)).cancel_requested_at).not.toBeNull();
    expect((await k.runs.get(manager.run.id)).cancel_requested_at).not.toBeNull();
    expect((await k.runs.get(child.run.id)).cancel_requested_at).toBeNull();
    expect(
      (await child.call("read", { target: { kind: "node", nodeId: evidence.id } })).value.content,
    ).toBe("source evidence");
    await expect(
      manager.call("send_message", {
        target: { kind: "agent", agentId: worker.id },
        message: "stale manager work",
      }),
    ).rejects.toMatchObject({ code: "STALE_EXECUTION" });
    expect(await incoming(worker)).toHaveLength(0);
  },
);

it("M05 a normal node breaks the management chain even when Agents are deeply nested visually", async () => {
  const top = await agent(),
    folder = await resource(top.id),
    lead = await agent(folder.id),
    worker = await agent(lead.id, "write"),
    rootEvidence = await resource(),
    localEvidence = await resource();
  await connect(top, rootEvidence);
  await connect(top, localEvidence);
  await connect(lead, localEvidence);
  await connect(worker, localEvidence);
  const child = await start(worker);
  expect(await managementChain(k.db.pool, worker.id)).toEqual([lead.id]);
  expect((await child.call("report_result", { message: "local report" })).value.recipients).toEqual(
    [lead.id],
  );
  expect(
    (
      await child.call("send_message", {
        target: { kind: "agent", agentId: top.id },
        message: "not an ancestor team",
      })
    ).waiting,
  ).toBe("approval");
  expect(await incoming(top)).toHaveLength(0);
  const moved = await k.graph.submitMove({
    targetParentId: folder.id,
    moves: [{ nodeId: worker.id, x: 2, y: 2 }],
    idempotencyKey: key(),
  });
  expect(await managementChain(k.db.pool, worker.id)).toEqual([]);
  expect((await child.call("report_result", { message: "no manager" })).value.delivered).toBe(0);
  expect(await incoming(lead)).toHaveLength(1);
  await k.graph.undoGraphOp(moved.graphOpId);
  expect(await managementChain(k.db.pool, worker.id)).toEqual([lead.id]);
});

it("M06 a deep artifact is shared only with readable ancestors and explicitly reports skipped managers", async () => {
  const { top, division, lead, worker } = await tree(),
    sibling = await agent(lead.id, "write"),
    privateEvidence = await resource();
  await connect(lead, privateEvidence);
  await connect(worker, privateEvidence);
  const director = await start(top),
    divisionManager = await start(division),
    manager = await start(lead),
    child = await start(worker);
  const artifact = await child.call("create_artifact", {
    kind: "text",
    title: "scoped leaf report",
    text: "private branch evidence",
    shareWithManagers: true,
  });
  expect(artifact.value.sharedWith).toEqual([lead.id]);
  // Delivery state must distinguish one eligible manager receiving the artifact
  // from a complete block: callers must not retry the successful portion.
  expect(artifact.value.sharing.status).toBe("partial");
  expect(artifact.value.sharing.skippedManagers).toEqual([division.id, top.id]);
  expect(
    (await manager.call("read", { target: { kind: "node", nodeId: artifact.value.id } })).value
      .content,
  ).toBe("private branch evidence");
  for (const a of [top, division, sibling])
    expect(await scope(a)).not.toContain(`${artifact.value.id}:write`);
  for (const session of [director, divisionManager]) {
    const blocked = await session.call("read", {
      target: { kind: "node", nodeId: artifact.value.id },
    });
    expect(blocked.waiting).toBe("approval");
    expect(JSON.stringify(blocked.result)).not.toContain("private branch evidence");
  }
  expect(
    (await child.call("report_result", { message: "report ready for direct manager" })).value
      .recipients,
  ).toEqual([lead.id]);
  expect(await incoming(top)).toHaveLength(0);
  expect(await incoming(division)).toHaveLength(0);
});

it("M07 an expired branch request cannot cancel or authorize its cousin's concurrent request", async () => {
  const { top, lead, worker } = await tree(),
    otherDivision = await agent(top.id),
    otherLead = await agent(otherDivision.id),
    cousin = await agent(otherLead.id, "read");
  await k.graph.updateNode(worker.id, {
    expectedRevision: worker.revision,
    agent: { ...worker.agent!, role: "read" },
    idempotencyKey: key(),
  });
  const manager = await start(lead),
    otherManager = await start(otherLead),
    child = await start(worker),
    peer = await start(cousin);
  const left = await child.call("request_permission", {
      scope: { kind: "role", role: "write" },
      reason: "left work",
    }),
    right = await peer.call("request_permission", {
      scope: { kind: "role", role: "write" },
      reason: "right work",
    });
  expect((await request(left.value.requestId)).assigned_reviewer_id).toBe(lead.id);
  expect((await request(right.value.requestId)).assigned_reviewer_id).toBe(otherLead.id);
  await expect(decide(right.value.requestId, manager)).rejects.toMatchObject({ code: "FORBIDDEN" });
  await k.db.pool.query("update approvals set expires_at=now()-interval '1 second' where id=$1", [
    left.value.requestId,
  ]);
  await k.access.maintain();
  expect((await request(left.value.requestId)).status).toBe("expired");
  expect((await request(right.value.requestId)).status).toBe("pending");
  await expect(decide(left.value.requestId, manager)).rejects.toMatchObject({
    code: "VERSION_CONFLICT",
  });
  await decide(right.value.requestId, otherManager);
  expect((await k.graph.queries.node(worker.id)).agent!.role).toBe("read");
  expect((await k.graph.queries.node(cousin.id)).agent!.role).toBe("write");
  expect((await k.runs.get(child.run.id)).cancel_requested_at).toBeNull();
  expect((await k.runs.get(peer.run.id)).cancel_requested_at).toBeNull();
  const expired = await child.call(
    "request_permission",
    { scope: { kind: "role", role: "write" }, reason: "left work" },
    left.logical,
  );
  expect(expired.result.isError).toBe(true);
  expect(expired.value.executed).toBe(false);
});

it("M08 concurrent deep-team broadcasts use resource intersection, deduplicate replays and activate each inbox once", async () => {
  const { top, division, lead, worker } = await tree(),
    otherDivision = await agent(top.id),
    otherLead = await agent(otherDivision.id),
    cousin = await agent(otherLead.id, "write"),
    folder = await resource(top.id),
    outsideTeam = await agent(folder.id, "write"),
    partial = await agent(top.id, "write"),
    none = await agent(top.id, "write"),
    firstResource = await resource(),
    secondResource = await resource();
  const participants = [top, division, lead, worker, otherDivision, otherLead, cousin, outsideTeam];
  for (const a of participants) {
    await connect(a, firstResource);
    await connect(a, secondResource);
  }
  await connect(partial, firstResource);
  const child = await start(worker),
    peer = await start(cousin),
    args = {
      target: {
        kind: "resource_readers",
        resourceIds: [firstResource.id, secondResource.id, firstResource.id],
      },
      message: "same content, independent senders",
    };
  const sends = await Promise.all([
    child.call("send_message", args, "leaf-broadcast"),
    peer.call("send_message", args, "cousin-broadcast"),
  ]);
  for (const [index, sender] of [worker, cousin].entries()) {
    expect(sends[index]!.waiting).toBeUndefined();
    expect(sends[index]!.value.recipients).toEqual(
      participants
        .filter((a) => a.id !== sender.id)
        .map((a) => a.id)
        .sort(),
    );
  }
  expect((await child.call("send_message", args, "leaf-broadcast")).value).toEqual(sends[0]!.value);
  await k.access.maintain();
  for (const a of participants) {
    const received = await incoming(a);
    expect(received.map((m) => m.content.from).sort()).toEqual(
      [worker, cousin]
        .filter((sender) => sender.id !== a.id)
        .map((sender) => sender.id)
        .sort(),
    );
    expect(
      (
        await k.db.pool.query(
          "select r.id from runs r join conversations c on c.id=r.subject_id where c.agent_id=$1 and r.state in('queued','running','waiting')",
          [a.id],
        )
      ).rows,
    ).toHaveLength(1);
  }
  for (const a of [partial, none]) expect(await incoming(a)).toHaveLength(0);
  await k.access.maintain();
  expect(await incoming(outsideTeam)).toHaveLength(2);
  const remaining = new Set(
    participants.filter((a) => ![worker.id, cousin.id].includes(a.id)).map((a) => a.id),
  );
  while (remaining.size) {
    const run = (await k.runs.claim("multi-level-recipient"))!;
    expect(remaining.has(run?.frozen_input.agentId)).toBe(true);
    const ctx = { run, store: k.runs, signal: new AbortController().signal, progress() {} };
    await k.conversations.execute(ctx, (ctx, input) => k.tools.create(ctx, input));
    expect((await k.runs.get(run.id)).state).toBe("succeeded");
    const consumed = (
      await k.db.pool.query(
        "select checkpoint,consumed_message_seq from conversations where agent_id=$1",
        [run.frozen_input.agentId],
      )
    ).rows[0];
    expect(JSON.stringify(consumed.checkpoint)).toContain(args.message);
    const recipient = participants.find((a) => a.id === run.frozen_input.agentId)!;
    expect(Number(consumed.consumed_message_seq)).toBeGreaterThanOrEqual(
      Number((await incoming(recipient)).at(-1).seq),
    );
    remaining.delete(run.frozen_input.agentId);
  }
  await k.access.maintain();
  expect(await k.runs.claim("multi-level-drained")).toBeNull();
});

it("M09 hierarchy does not expose private transcripts to ancestors, siblings or direct managers", async () => {
  const { top, division, lead, worker } = await tree(),
    sibling = await agent(lead.id, "write");
  const director = await start(top),
    divisionManager = await start(division),
    manager = await start(lead),
    child = await start(worker),
    peer = await start(sibling);
  await k.conversations.submit({
    canvasId: board,
    agentId: worker.id,
    message: "private user instruction: do not redistribute",
    key: key(),
  });
  await child.call("report_result", { message: "public direct-manager report" });
  await child.call("send_message", {
    target: { kind: "agent", agentId: sibling.id },
    message: "sibling-only coordination",
  });
  const own = await child.call("read_conversation", {}),
    direct = await manager.call("read_conversation", { agentId: worker.id });
  expect(JSON.stringify(own.value)).toContain("private user instruction: do not redistribute");
  expect(JSON.stringify(direct.value)).toContain("public direct-manager report");
  expect(JSON.stringify(direct.value)).not.toContain("private user instruction");
  expect(JSON.stringify(direct.value)).not.toContain("sibling-only coordination");
  for (const session of [director, divisionManager, peer]) {
    const blocked = await session.call("read_conversation", { agentId: worker.id });
    expect(blocked.result.isError).toBe(true);
    expect(JSON.stringify(blocked.value)).not.toContain("public direct-manager report");
    expect(JSON.stringify(blocked.value)).not.toContain("private user instruction");
  }
});

it.each(["private", "complete"] as const)(
  "M10 deep artifact sharing labels intentional %s delivery without granting side branches",
  async (status) => {
    const { top, division, lead, worker } = await tree(),
      sibling = await agent(lead.id, "write"),
      child = await start(worker);
    const artifact = await child.call("create_artifact", {
      kind: "text",
      title: `${status} output`,
      text: "saved once",
      shareWithManagers: status !== "private",
    });
    expect(artifact.value.sharing).toEqual({ status, skippedManagers: [] });
    expect(artifact.value.sharedWith).toEqual(
      status === "private" ? [] : [top.id, division.id, lead.id].sort(),
    );
    expect((await scope(sibling)).some((grant) => grant.startsWith(`${artifact.value.id}:`))).toBe(
      false,
    );
    for (const manager of [top, division, lead]) {
      expect(
        (await scope(manager)).some((grant) => grant.startsWith(`${artifact.value.id}:`)),
      ).toBe(status === "complete");
    }
    if (status === "complete") {
      await k.graph.deleteNodes({ nodeIds: [worker.id], idempotencyKey: key() });
      expect((await k.graph.queries.node(artifact.value.id)).text).toBe("saved once");
      for (const manager of [top, division, lead])
        expect(
          (await scope(manager)).some((grant) => grant.startsWith(`${artifact.value.id}:`)),
        ).toBe(true);
    }
  },
);
