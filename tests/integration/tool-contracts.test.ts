import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { invokeTool } from "../../apps/server/dist/modules/execution/tool-calls.js";

const key = () => randomUUID();
const database = `intrica_contracts_${key().replaceAll("-", "")}`;
let app: Awaited<ReturnType<typeof buildServer>>, k: Kernel, admin: pg.Client;
let directory: string, board: string;
const position = { x: 0, y: 0, width: 220, height: 300 };
beforeAll(async () => {
  const url = new URL(process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres");
  admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  await admin.query(`create database ${database}`);
  url.pathname = `/${database}`;
  directory = await realpath(await mkdtemp(join(tmpdir(), "intrica-contracts-")));
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
async function agent(parentId = board, enabled = false) {
  return (
    await k.graph.createNode({
      kind: "agent",
      title: "Member",
      parentId,
      position,
      agent: { role: "write", persona: "", enabled },
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
      const t = tools.find((t) => t.name === name)!;
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
it("owner and Agent file operations share contracts and commit whole edit batches", async () => {
  const a = await agent(),
    member = await start(a.id),
    owner = await start();
  for (const name of ["read", "write", "edit", "bash"])
    expect(member.tools.find((t) => t.name === name)!.parameters).toEqual(
      owner.tools.find((t) => t.name === name)!.parameters,
    );
  for (const s of [member, owner]) {
    const path = join(await k.host.workspace(board, s === member ? a.id : undefined), key());
    await writeFile(path, "alpha beta gamma");
    const rejected = await s.call("edit", {
      path,
      edits: [
        { oldText: "alpha", newText: "changed" },
        { oldText: "missing", newText: "delta" },
      ],
    });
    expect(rejected.result.isError).toBe(true);
    expect(await readFile(path, "utf8")).toBe("alpha beta gamma");
    expect(
      (
        await s.call("edit", {
          path,
          edits: [
            { oldText: "alpha beta", newText: "x" },
            { oldText: "beta", newText: "y" },
          ],
        })
      ).result.isError,
    ).toBe(true);
    expect(await readFile(path, "utf8")).toBe("alpha beta gamma");
    expect(
      (
        await s.call("edit", {
          path,
          edits: [
            { oldText: "alpha", newText: "beta" },
            { oldText: "beta", newText: "delta" },
          ],
        })
      ).result.isError,
    ).not.toBe(true);
    expect(await readFile(path, "utf8")).toBe("beta delta gamma");
  }
  expect(
    owner.tools
      .filter((t) => t.modelVisible !== false)
      .some((t) => t.name === "request_permission"),
  ).toBe(false);
  expect(
    (
      await owner.call("request_permission", {
        scope: { kind: "role", role: "admin" },
        reason: "invalid identity",
      })
    ).result.isError,
  ).toBe(true);
});

it("typed operation branches reject mixed fields before creating effects", async () => {
  const a = await agent(),
    s = await start(a.id);
  const created = await s.call("create_artifact", {
    kind: "todo",
    title: "Checklist",
    text: "- [ ] one",
  });
  const n = await k.graph.queries.node(created.value.id);
  for (const [name, args] of [
    [
      "update_node",
      {
        nodeId: n.id,
        expectedRevision: n.revision,
        patch: { kind: "content", text: "changed", itemIndex: 0, completed: true },
      },
    ],
    ["create_artifact", { kind: "todo", title: "Invalid", path: directory }],
    [
      "request_permission",
      { scope: { kind: "role", role: "admin", nodeId: n.id }, reason: "mixed scope" },
    ],
  ] as const)
    expect((await s.call(name, args)).result.isError).toBe(true);
  expect((await k.graph.queries.node(n.id)).text).toBe("- [ ] one");
  expect((await k.access.list(board, { status: "pending" })).requests).toHaveLength(0);
});

it("self schedules require revisions and remain independent of resource activation and run cancellation", async () => {
  const a = await agent(),
    s = await start(a.id);
  const schedule = { cron: "0 9 * * *", timezone: "UTC", prompt: "Review", enabled: true };
  expect(
    (await s.call("configure_agent", { expectedRevision: a.revision + 1, patch: { schedule } }))
      .result.isError,
  ).toBe(true);
  expect(
    (await s.call("configure_agent", { expectedRevision: a.revision, patch: { schedule } })).result
      .isError,
  ).not.toBe(true);
  let current = await k.graph.queries.node(a.id);
  expect(current.agent).toMatchObject({ enabled: false, schedule: { enabled: true } });
  expect(
    (
      await k.db.pool.query("select enabled from schedules where agent_id=$1 and kind='cron'", [
        a.id,
      ])
    ).rows,
  ).toEqual([{ enabled: true }]);
  await k.graph.updateNode(a.id, {
    expectedRevision: current.revision,
    agent: { ...current.agent!, enabled: true },
    idempotencyKey: key(),
  });
  current = await k.graph.queries.node(a.id);
  await k.graph.updateNode(a.id, {
    expectedRevision: current.revision,
    agent: { ...current.agent!, enabled: false },
    idempotencyKey: key(),
  });
  expect((await k.runs.get(s.run.id)).cancel_requested_at).toBeNull();
  current = await k.graph.queries.node(a.id);
  const mixed = await s.call("configure_agent", {
    expectedRevision: current.revision,
    patch: { schedule, role: "admin" },
  });
  expect(mixed.waiting).toBe("approval");
  expect((await k.graph.queries.node(a.id)).agent!.role).toBe("write");
  await k.runs.finish(s.run, "succeeded");
  await k.db.pool.query(
    "update schedules set next_due_at=now()-interval '1 second' where agent_id=$1",
    [a.id],
  );
  await k.tools.tickSchedules();
  expect(
    (
      await k.db.pool.query("select 1 from runs where subject_id=$1 and state='queued'", [
        s.run.subject_id,
      ])
    ).rowCount,
  ).toBe(1);
});

it("private artifacts do not schedule managers, while explicitly shared artifacts do", async () => {
  const manager = await agent(board, true),
    member = await agent(manager.id),
    s = await start(member.id);
  await k.db.pool.query("delete from schedules where agent_id=$1", [manager.id]);
  const privateOutput = await s.call("create_artifact", {
    kind: "text",
    title: "Draft",
    text: "Private",
    shareWithManagers: false,
  });
  expect(privateOutput.value.sharing.status).toBe("private");
  expect(
    (await k.db.pool.query("select 1 from schedules where agent_id=$1 and enabled", [manager.id]))
      .rowCount,
  ).toBe(0);
  const publisher = await agent(manager.id),
    publicSession = await start(publisher.id);
  await publicSession.call("create_artifact", {
    kind: "text",
    title: "Report",
    text: "Shared",
    shareWithManagers: true,
  });
  expect(
    (
      await k.db.pool.query(
        "select 1 from schedules where agent_id=$1 and kind='resource_change' and enabled",
        [manager.id],
      )
    ).rowCount,
  ).toBe(1);
});

it("read cursors bind targets, preserve complete content and cannot grant indexed-skill access", async () => {
  const a = await agent(),
    s = await start(a.id);
  const path = join(await k.host.workspace(board, a.id), "lines.txt");
  const full = "line\n".repeat(601);
  await writeFile(path, full);
  await writeFile(`${path}.other`, "Different authorized content");
  const first = await s.call("read", { target: { kind: "path", path } });
  expect(first.value.nextCursor).toEqual(expect.any(String));
  const forged = await s.call("read", {
    target: { kind: "path", path: `${path}.other` },
    cursor: first.value.nextCursor,
  });
  expect(forged.result.isError).toBe(true);
  expect(
    (
      await s.call("read", {
        target: { kind: "path", path },
        cursor: first.value.nextCursor,
        line: 1,
      })
    ).result.isError,
  ).toBe(true);
  let output = first.value.text,
    cursor = first.value.nextCursor;
  while (cursor) {
    const page = await s.call("read", { target: { kind: "path", path }, cursor });
    expect(page.result.isError).not.toBe(true);
    output += page.value.text;
    cursor = page.value.nextCursor;
  }
  expect(output).toBe(full);
  expect((await s.call("read", { target: { kind: "skill", skillId: path } })).result.isError).toBe(
    true,
  );
  const saved = await s.call("create_artifact", {
    kind: "text",
    title: "Long note",
    text: "abc".repeat(5000),
    shareWithManagers: false,
  });
  const page = await s.call("read", { target: { kind: "node", nodeId: saved.value.id } });
  let text = page.value.content,
    more = page.value.nextCursor;
  while (more) {
    const next = await s.call("read", {
      target: { kind: "node", nodeId: saved.value.id },
      cursor: more,
    });
    text += next.value.content;
    more = next.value.nextCursor;
  }
  expect(text).toBe("abc".repeat(5000));
});

it("workspace history returns its own messages and denies cross-canvas history", async () => {
  const a = await agent(),
    owner = await start();
  for (let i = 0; i < 90; i++)
    await k.db.canvas(board, (tx) =>
      k.conversations.append(tx, owner.run.subject_id, key(), "user", { text: `entry-${i}` }),
    );
  const history = await owner.call("read_conversation", {});
  expect(history.value.events).toHaveLength(80);
  expect(history.value.nextBefore).toEqual(expect.any(Number));
  expect(
    (await owner.call("read_conversation", { before: history.value.nextBefore })).value.events
      .length,
  ).toBeGreaterThan(0);
  const other = (await k.graph.createCanvas({ title: "Other", idempotencyKey: key() })).node.id;
  const outsider = await agent(other);
  expect((await owner.call("read_conversation", { agentId: outsider.id })).result.isError).toBe(
    true,
  );
  expect((await owner.call("read_conversation", { agentId: a.id })).result.isError).not.toBe(true);
});
