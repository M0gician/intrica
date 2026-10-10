import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentRole, agentNamePool } from "@intrica/contracts";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { Value } from "typebox/value";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { Agent } from "../../apps/server/dist/adapters/model/agent.js";
import { digest } from "../../apps/server/dist/adapters/postgres/database.js";
import { invokeTool } from "../../apps/server/dist/modules/execution/tool-calls.js";
import { addressedOutput } from "../fixtures/addressed-output.mjs";

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
  vi.restoreAllMocks();
  await k.db.pool.query("update approvals set status='cancelled' where status='pending'");
  await k.db.pool.query(
    "update tool_calls set state='failed',delivered_at=now() where state not in ('succeeded','failed')",
  );
  await k.db.pool.query(
    "update runs set state='cancelled' where state in ('queued','running','waiting')",
  );
  await k.db.pool.query("update schedules set enabled=false");
  await k.db.pool.query("update conversations set consumed_message_seq=message_seq");
  await k.db.pool.query(
    "update messages set content=content||'{\"closed\":true}'::jsonb where consumed_run_id is null",
  );
});
afterAll(async () => {
  await app?.close();
  await admin.query(`drop database if exists ${database} with(force)`);
  await admin.end();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function agent(parentId = board, enabled = false, role: AgentRole = "write") {
  return (
    await k.graph.createNode({
      kind: "agent",
      title: "Member",
      parentId,
      position,
      agent: { role, persona: "", enabled },
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
  const resumed = await s.call("read", {
    target: { kind: "path", path },
    cursor: first.value.nextCursor,
  });
  expect(
    (
      await s.call("read", {
        target: { kind: "path", path },
        cursor: first.value.nextCursor,
        mode: "auto",
      })
    ).value,
  ).toEqual(resumed.value);
  expect(
    (
      await s.call("read", {
        target: { kind: "path", path },
        cursor: first.value.nextCursor,
        mode: "text",
      })
    ).result.isError,
  ).toBe(true);
  const textFirst = await s.call("read", { target: { kind: "path", path }, mode: "text" });
  expect(
    (
      await s.call("read", {
        target: { kind: "path", path },
        cursor: textFirst.value.nextCursor,
        mode: "text",
      })
    ).value,
  ).toEqual(
    (await s.call("read", { target: { kind: "path", path }, cursor: textFirst.value.nextCursor }))
      .value,
  );
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

it.each(["read", "write", "admin", "owner"] as const)(
  "tool discovery and prompt capabilities agree for %s",
  async (role) => {
    const member = role === "owner" ? undefined : await agent(board, false, role);
    const s = await start(member?.id);
    const visible = s.tools.filter((t) => t.modelVisible !== false);
    const parameters = (name: string) => {
      const tool = visible.find((t) => t.name === name)!;
      return tool.modelParameters ?? tool.parameters;
    };
    expect(s.tools.capabilities?.role).toBe(role);
    for (const name of ["hire_agent", "dismiss_agent", "review_access_request"])
      expect(visible.some((t) => t.name === name)).toBe(["admin", "owner"].includes(role));
    expect(visible.some((t) => t.name === "take_over_run")).toBe(role === "admin");
    expect(visible.some((t) => t.name === "create_artifact")).toBe(role !== "read");
    const send = parameters("send_message");
    expect(
      Value.Check(send, { kind: "update", target: { kind: "canvas" }, message: "coordinate" }),
    ).toBe(["admin", "owner"].includes(role));
    if (role === "read" || role === "write") {
      expect(
        Value.Check(parameters("configure_agent"), {
          expectedRevision: 1,
          patch: { schedule: null },
        }),
      ).toBe(true);
      expect(
        Value.Check(parameters("configure_agent"), {
          expectedRevision: 1,
          patch: { persona: "manager" },
        }),
      ).toBe(false);
      expect(
        Value.Check(parameters("configure_agent"), {
          agentId: "another-agent",
          expectedRevision: 1,
          patch: { schedule: null },
        }),
      ).toBe(false);
      expect(Value.Check(parameters("read_conversation"), { agentId: "another-agent" })).toBe(
        false,
      );
      expect(visible.find((t) => t.name === "list_access_requests")!.description).toContain("own");
      const descriptions = visible.map((t) => t.description).join("\n");
      expect(descriptions).not.toMatch(/take.?over|took over|hire_agent|review_access_request/);
      expect(
        Value.Check(parameters("send_message"), {
          target: { kind: "manager" },
          kind: "result",
          message: "progress",
          resourceIds: [],
        }),
      ).toBe(false);
    }
    if (role === "admin") {
      const args = { persona: "role", task: "first", role: "admin", respondToResources: false };
      expect(Value.Check(parameters("hire_agent"), args)).toBe(false);
      expect(Value.Check(parameters("hire_agent"), { ...args, role: "write" })).toBe(true);
    }
    if (role === "owner") {
      const to = await agent();
      expect(
        (
          await s.call("send_message", {
            kind: "update",
            target: { kind: "canvas" },
            message: "owner broadcast",
          })
        ).value.recipients,
      ).toEqual([to.id]);
    }
  },
);

it("random names are server-owned, unique across concurrent hiring and UI creation, and stable on replay", async () => {
  const manager = await agent(board, false, "admin"),
    s = await start(manager.id);
  const count = agentNamePool("en").length + 5;
  const args = {
    persona: "A careful reviewer; the job title is not a name",
    task: "Inspect independent evidence",
    role: "write",
    respondToResources: false,
  };
  const hires = await Promise.all(Array.from({ length: count }, () => s.call("hire_agent", args)));
  const manual = await Promise.all(
    Array.from({ length: count }, () =>
      k.graph.createNode({
        kind: "agent",
        parentId: board,
        position,
        idempotencyKey: key(),
        agent: { role: "read", enabled: false, persona: "" },
      }),
    ),
  );
  const names = [...hires.map((h) => h.value.title), ...manual.map((r) => r.node.title)];
  expect(new Set(names).size).toBe(count * 2);
  for (const name of names) expect(agentNamePool("en")).toContain(name.replace(/ \d+$/, ""));
  for (const hire of hires) {
    expect((await s.call("hire_agent", args, hire.logical)).value).toEqual(hire.value);
    expect(
      (
        await k.db.pool.query(
          "select count(*)::int as n from messages m join conversations c on c.id=m.conversation_id where c.agent_id=$1 and m.content->>'messageKind'='request'",
          [hire.value.id],
        )
      ).rows[0].n,
    ).toBe(1);
  }
  const total = (
    await k.db.pool.query("select count(*)::int as n from nodes where canvas_id=$1", [board])
  ).rows[0].n;
  for (const field of ["title", "name", "displayName"]) {
    const rejected = await s.call("hire_agent", { ...args, [field]: "A job title" });
    expect(rejected.result.isError).toBe(true);
  }
  expect(
    (await k.db.pool.query("select count(*)::int as n from nodes where canvas_id=$1", [board]))
      .rows[0].n,
  ).toBe(total);
  const hired = await k.graph.queries.node(hires[0]!.value.id);
  expect(
    (
      await s.call("update_node", {
        nodeId: hired.id,
        expectedRevision: hired.revision,
        patch: { kind: "content", title: "Lead" },
      })
    ).result.isError,
  ).toBe(true);
  const renamed = await k.graph.updateNode(hired.id, {
    title: "User name",
    expectedRevision: hired.revision,
    idempotencyKey: key(),
  });
  expect(renamed.node.title).toBe("User name");
  expect((await k.conversations.read.forAgent(hired.id)).agent_id).toBe(hired.id);
});

it.each(["en", "zh-CN"] as const)(
  "owner and recovered hiring use %s names without accepting legacy titles on new calls",
  async (language) => {
    const manager = await agent(board, false, "admin"),
      s = await start(manager.id);
    s.run.frozen_input.language = language;
    const refreshed = await k.tools.create(s.ctx, s.run.frozen_input);
    const hire = refreshed.find((t) => t.name === "hire_agent")!;
    const args = {
      title: "Legacy job title",
      persona: "Analyst",
      task: "First task",
      role: "write",
      respondToResources: false,
    };
    const logical = key(),
      callId = key();
    await k.db.pool.query(
      "insert into tool_calls(id,run_id,attempt_id,logical_call_id,name,args,args_hash,effect_class,state) values($1,$2,$3,$4,'hire_agent',$5,$6,'graph','prepared')",
      [callId, s.run.id, s.run.attemptId, logical, JSON.stringify(args), digest(args)],
    );
    const out = await invokeTool(s.ctx, hire, logical, args);
    const value = JSON.parse((out.result.content[0] as { text: string }).text);
    expect(out.result.isError).not.toBe(true);
    expect(agentNamePool(language)).toContain(value.title);
    expect(value.title).not.toBe(args.title);
    expect(await invokeTool(s.ctx, hire, logical, args)).toEqual(out);
    expect((await invokeTool(s.ctx, hire, key(), args)).result.isError).toBe(true);
    expect(
      (await invokeTool(s.ctx, hire, key(), null, undefined, undefined, 1)).result.isError,
    ).toBe(true);
    const owner = await start();
    owner.run.frozen_input.language = language;
    const ownerHire = (await k.tools.create(owner.ctx, owner.run.frozen_input)).find(
      (t) => t.name === "hire_agent",
    )!;
    const { title: _title, ...current } = args;
    const response = await invokeTool(owner.ctx, ownerHire, key(), current);
    const created = JSON.parse((response.result.content[0] as { text: string }).text);
    expect(agentNamePool(language)).toContain(created.title);
    expect(created.title).not.toBe(value.title);
  },
);

it("failed hiring rolls back the generated name, member and task before retry", async () => {
  const manager = await agent(board, false, "admin"),
    s = await start(manager.id),
    logical = key();
  const args = { persona: "Review", task: "First task", role: "read", respondToResources: false };
  const before = (await k.db.pool.query("select id from nodes where canvas_id=$1", [board])).rows;
  vi.spyOn(k.conversations, "assignNewAgent").mockRejectedValueOnce(
    new Error("simulated transaction failure"),
  );
  await expect(s.call("hire_agent", args, logical)).rejects.toThrow(
    "simulated transaction failure",
  );
  expect((await k.db.pool.query("select id from nodes where canvas_id=$1", [board])).rows).toEqual(
    before,
  );
  const hired = await s.call("hire_agent", args, logical);
  expect(hired.result.isError).not.toBe(true);
  expect((await k.graph.queries.node(hired.value.id)).title).toBe(hired.value.title);
  expect((await s.call("hire_agent", args, logical)).value).toEqual(hired.value);
});

it.each([
  { version: undefined, role: "admin", expected: "succeeded" },
  { version: 2, role: "admin", expected: "invalid" },
  { version: undefined, role: "read", expected: "waiting" },
] as const)(
  "checkpoint-only hire recovery preserves version $version and current role $role",
  async ({ version, role, expected }) => {
    const manager = await agent(board, false, role),
      s = await start(manager.id),
      turnId = key(),
      callId = key();
    const args = {
      title: "Legacy title",
      persona: "Careful analysis",
      task: "Continue the saved assignment",
      role: "write",
      respondToResources: false,
    };
    const saved = {
      role: "assistant",
      api: "openai-completions",
      provider: "openai",
      model: "fixture",
      content: [{ type: "toolCall", id: callId, name: "hire_agent", arguments: args }],
      stopReason: "toolUse",
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
    await k.db.pool.query(
      "update conversations set checkpoint=$2,consumed_message_seq=message_seq,context=$3 where id=$1",
      [
        s.run.subject_id,
        JSON.stringify([saved]),
        JSON.stringify({ pendingTurnId: turnId, toolSchemaVersion: version }),
      ],
    );
    vi.spyOn(Agent.prototype, "turn").mockImplementation(async function (this: Agent) {
      expect(this.state.systemPrompt).toContain(`Current role: ${role}.`);
      const message = {
        ...saved,
        content: [
          { type: "text", text: addressedOutput(this.state.systemPrompt, "Recovery checked") },
        ],
        stopReason: "stop",
      } as Awaited<ReturnType<Agent["turn"]>>;
      this.state.messages.push(message);
      return message;
    });
    await k.conversations.execute(s.ctx, (ctx, input) => k.tools.create(ctx, input));
    const calls = (await k.db.pool.query("select * from tool_calls where run_id=$1", [s.run.id]))
      .rows;
    const children = (
      await k.db.pool.query("select body from nodes where parent_id=$1 and kind='agent'", [
        manager.id,
      ])
    ).rows;
    if (expected === "invalid") {
      expect(calls).toHaveLength(0);
      const history = (
        await k.db.pool.query("select checkpoint from conversations where id=$1", [
          s.run.subject_id,
        ])
      ).rows[0].checkpoint;
      expect(history.find((m: any) => m.role === "toolResult").isError).toBe(true);
    } else {
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        logical_call_id: `${turnId}:${callId}`,
        args_hash: digest(args),
        state: expected,
      });
      expect(calls[0].execution_input.title).toBeUndefined();
    }
    expect(children).toHaveLength(expected === "succeeded" ? 1 : 0);
    if (children.length) expect(agentNamePool("en")).toContain(children[0].body.title);
  },
);

it("each model request refreshes role, resource context and visible schemas from the same capability snapshot", async () => {
  const member = await agent(board, false, "read"),
    s = await start(member.id);
  const resource = (
    await k.graph.createNode({
      kind: "text",
      parentId: board,
      position,
      title: "Shared evidence",
      text: "evidence",
      idempotencyKey: key(),
    })
  ).node;
  let turn = 0;
  const roles: string[] = [];
  vi.spyOn(Agent.prototype, "turn").mockImplementation(async function (this: Agent) {
    turn++;
    const expected = ["read", "admin", "write"][turn - 1]!;
    roles.push(expected);
    expect(this.state.systemPrompt).toContain(`Current role: ${expected}.`);
    const names = this.state.tools.map((tool) => tool.name);
    expect(names.includes("hire_agent")).toBe(expected === "admin");
    expect(names.includes("review_access_request")).toBe(expected === "admin");
    if (expected !== "admin") {
      expect(this.state.systemPrompt).not.toContain("hire_agent");
      expect(this.state.systemPrompt).not.toContain("take_over_run");
      const configure = this.state.tools.find((t) => t.name === "configure_agent")!;
      expect(
        Value.Check(configure.parameters, { expectedRevision: 1, patch: { role: "admin" } }),
      ).toBe(false);
    }
    if (turn > 1) expect(this.state.systemPrompt).toContain(resource.id);
    if (turn === 1) {
      await k.db.pool.query(
        "update agent_configs set config=jsonb_set(config,'{role}','\"admin\"') where node_id=$1",
        [member.id],
      );
      await k.graph.createLink({ fromId: member.id, toId: resource.id, idempotencyKey: key() });
    } else if (turn === 2) {
      await k.db.pool.query(
        "update agent_configs set config=jsonb_set(config,'{role}','\"write\"') where node_id=$1",
        [member.id],
      );
    }
    const message: Awaited<ReturnType<Agent["turn"]>> = {
      role: "assistant",
      api: this.state.model.api,
      provider: this.state.model.provider,
      model: this.state.model.id,
      content:
        turn < 3
          ? [{ type: "toolCall", id: `round-${turn}`, name: "read_canvas", arguments: {} }]
          : [{ type: "text", text: addressedOutput(this.state.systemPrompt, "verified") }],
      stopReason: turn < 3 ? "toolUse" : "stop",
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
  expect(roles).toEqual(["read", "admin", "write"]);
  const history = await k.conversations.read.forAgent(member.id);
  const checkpoint = (
    await k.db.pool.query("select checkpoint from conversations where id=$1", [history.id])
  ).rows[0].checkpoint;
  expect(
    checkpoint.some(
      (m: any) => m.role === "user" && JSON.stringify(m.content).includes("Contract verification"),
    ),
  ).toBe(true);
  expect(
    checkpoint.filter((m: any) => m.role === "toolResult" && m.toolName === "read_canvas"),
  ).toHaveLength(2);
  expect(checkpoint.at(-1)?.role).toBe("assistant");
  expect(JSON.parse(checkpoint.at(-1).content[0].text)).toMatchObject({
    target: { kind: "request" },
    kind: "result",
    message: "verified",
  });
});
