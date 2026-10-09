import { fork, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { socketPath } from "../../apps/server/dist/adapters/host/rpc.js";
import * as hostSandbox from "../../apps/server/dist/adapters/host/sandbox.js";
import {
  cleanEnvironment,
  runProcess,
  sandboxCommand,
} from "../../apps/server/dist/adapters/host/sandbox.js";
import {
  finishModelCall,
  startModelCall,
  withModelUsage,
} from "../../apps/server/dist/adapters/model/usage.js";
import { authorize, grantsFor } from "../../apps/server/dist/modules/access/policy.js";
import { RunStore } from "../../apps/server/dist/modules/execution/store.js";
import { invokeTool } from "../../apps/server/dist/modules/execution/tool-calls.js";
import { Worker } from "../../apps/server/dist/modules/execution/worker.js";

const key = () => randomUUID();
it("fixed file helper separates stdout from runtime diagnostics without masking its exit code", async () => {
  for (const exitCode of [0, 2]) {
    const response = await runProcess(
      process.execPath,
      [
        "-e",
        `process.stderr.write('runtime diagnostic\\n');process.stdout.write('{"value":true}');process.exitCode=${exitCode}`,
      ],
      process.cwd(),
      cleanEnvironment("/tmp"),
      AbortSignal.timeout(5000),
      5000,
      true,
    );
    expect(response).toEqual({
      output: '{"value":true}',
      exitCode,
      signal: null,
      termination: "exited",
      taskStatus: "unverified",
    });
  }
});
const adminUrl = process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres";
let app: Awaited<ReturnType<typeof buildServer>>, k: Kernel, dir: string;
const dbName = `intrica_v2_${key().replaceAll("-", "")}`;
const token = key();
async function admin(sql: string) {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}
const canvas = async () =>
  (await k.graph.createCanvas({ title: "验证画布", idempotencyKey: key() })).node.id;
const node = async (canvasId: string, title = "来源", kind: "text" | "agent" = "text") =>
  k.graph.createNode({
    kind,
    parentId: canvasId,
    title,
    text: "正文",
    position: { x: 20, y: 20, width: 240, height: 160 },
    ...(kind === "agent"
      ? { agent: { persona: "研究助手", role: "write" as const, enabled: true } }
      : {}),
    idempotencyKey: key(),
  });
async function _eventually(check: () => Promise<boolean>, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("condition not reached");
}
beforeAll(async () => {
  await admin(`create database ${dbName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  dir = await mkdtemp(join(tmpdir(), "intrica-v2-test-"));
  app = await buildServer({
    databaseUrl: url.href,
    dataDir: dir,
    accessToken: token,
    worker: false,
    model: { kind: "mock", supportsVision: true, streamDelayMs: 0 },
  });
  await app.ready();
  k = app.kernel;
});
afterAll(async () => {
  await app?.close();
  await admin(`drop database if exists ${dbName} with(force)`);
  if (dir) await rm(dir, { recursive: true, force: true });
});
describe("production graph and execution", () => {
  it("persists execution policy across schedulers and drains lowered limits without cancelling work", async () => {
    const canvasId = await canvas();
    const baseline = await k.runs.settings.read();
    const changed = await k.runs.settings.save(baseline.revision, {
      ...baseline.policy,
      agents: 2,
    });
    await expect(k.runs.settings.save(baseline.revision, baseline.policy)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
    const second = new RunStore(k.db, { ...k.runs.limits });
    await second.settings.initialize();
    expect((await second.settings.read()).policy.agents).toBe(2);
    const jobs = [];
    for (let i = 0; i < 3; i++)
      jobs.push(
        await k.db.canvas(canvasId, (tx) =>
          k.runs.enqueue(tx, { canvasId, subjectId: key(), kind: "conversation", frozen: {} }),
        ),
      );
    const a = (await second.claim("policy-worker"))!,
      b = (await second.claim("policy-worker"))!;
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    const lowered = await k.runs.settings.save(changed.revision, { ...changed.policy, agents: 1 });
    expect(await second.claim("policy-worker")).toBeNull();
    expect((await k.runs.get(a.id)).state).toBe("running");
    await k.runs.finish(a, "succeeded");
    expect(await second.claim("policy-worker")).toBeNull();
    await k.runs.finish(b, "succeeded");
    const last = (await second.claim("policy-worker"))!;
    expect(last).toBeTruthy();
    await k.runs.finish(last, "succeeded");
    await k.runs.settings.save(lowered.revision, baseline.policy);
  });
  it("records per-call usage once, includes cache in input, and preserves unavailable attempts", async () => {
    const canvasId = await canvas();
    await withModelUsage(
      {
        db: k.db,
        purpose: "generation",
        canvasId,
        model: {
          config: {
            kind: "pi",
            provider: "fixture",
            modelId: "metered",
            api: "openai-completions",
          },
        },
      },
      async () => {
        const call = await startModelCall();
        const message: any = { usage: { input: 80, output: 10, cacheRead: 20, cacheWrite: 0 } };
        await finishModelCall(call, "succeeded", message);
        await finishModelCall(call, "succeeded", {
          ...message,
          usage: { ...message.usage, input: 9000 },
        });
        await finishModelCall(await startModelCall(), "error");
        await startModelCall();
      },
    );
    const report = await k.statistics.usage({
      from: new Date(Date.now() - 60000).toISOString(),
      to: new Date(Date.now() + 1000).toISOString(),
      canvasId,
    });
    expect(report.rows).toEqual([
      expect.objectContaining({
        calls: 3,
        reported: 1,
        unfinished: 1,
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 20,
        simulated: false,
      }),
    ]);
  });
  it("renames canvases without conflicting with content edits and rejects stale rename or undo", async () => {
    const id = await canvas();
    const headers = { authorization: `Bearer ${token}` };
    const payload = { title: "  调查归档  ", expectedTitle: "验证画布", idempotencyKey: key() };
    await node(id);
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/v2/canvases/${id}`,
      headers,
      payload,
    });
    expect(renamed.statusCode).toBe(200);
    expect((await k.graph.queries.node(id)).title).toBe("调查归档");
    expect(
      (
        await app.inject({ method: "PATCH", url: `/api/v2/canvases/${id}`, headers, payload })
      ).json(),
    ).toEqual(renamed.json());
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v2/canvases/${id}`,
          headers,
          payload: { ...payload, title: "   ", idempotencyKey: key() },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v2/canvases/${id}`,
          headers,
          payload: { ...payload, title: "旧窗口", idempotencyKey: key() },
        })
      ).statusCode,
    ).toBe(409);
    const next = await k.graph.renameCanvas(id, {
      title: "最终名称",
      expectedTitle: "调查归档",
      idempotencyKey: key(),
    });
    await expect(k.graph.undoGraphOp(renamed.json().graphOpId)).rejects.toMatchObject({
      code: "UNDO_CONFLICT",
    });
    await k.graph.undoGraphOp(next.graphOpId);
    await k.graph.undoGraphOp(renamed.json().graphOpId);
    expect((await k.graph.queries.node(id)).title).toBe("验证画布");
  });
  it("requires owner auth on loopback; establishes cookie and rejects wrong protocol", async () => {
    expect((await app.inject({ url: "/api/v2/bootstrap" })).statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/api/v2/session", payload: { token } });
    expect(login.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          url: "/api/v2/bootstrap",
          headers: { cookie: login.headers["set-cookie"] as string },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: "/api/v1/bootstrap",
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(404);
  });
  it("scopes bootstrap, replays commands, separates content and layout versions, and explicitly undoes", async () => {
    const a = await canvas(),
      b = await canvas();
    const input = {
      kind: "text" as const,
      parentId: a,
      title: "长文",
      text: "正文".repeat(5000),
      position: { x: 0, y: 0, width: 240, height: 160 },
      idempotencyKey: key(),
    };
    const first = await k.graph.createNode(input);
    expect((await k.graph.createNode(input)).node.id).toBe(first.node.id);
    await expect(k.graph.createNode({ ...input, title: "变更" })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    const other = await node(b);
    const snapshot = await k.bootstrap(a);
    expect(snapshot.nodes.some((n) => n.id === other.node.id)).toBe(false);
    expect(snapshot.nodes.find((n) => n.id === first.node.id)?.text?.length).toBeLessThanOrEqual(
      400,
    );
    const moved = await k.graph.submitMove({
      targetParentId: a,
      moves: [{ nodeId: first.node.id, x: 90, y: 40, expectedLayoutVersion: 1 }],
      idempotencyKey: key(),
    });
    const updated = await k.graph.updateNode(first.node.id, {
      text: "新正文",
      expectedRevision: 1,
      idempotencyKey: key(),
    });
    expect(updated.node.layoutVersion).toBe(2);
    await k.graph.undoGraphOp(moved.graphOpId);
    expect((await k.graph.queries.node(first.node.id)).text).toBe("新正文");
    await k.graph.undoGraphOp(updated.graphOpId);
    expect((await k.graph.queries.node(first.node.id)).text).toBe(input.text);
    const deleted = await k.graph.deleteCanvas(b, { idempotencyKey: "delete" });
    expect(await k.graph.deleteCanvas(b, { idempotencyKey: "delete" })).toEqual(deleted);
    await k.graph.undoGraphOp(deleted.graphOpId);
    expect((await k.bootstrap(b)).activeCanvasId).toBe(b);
  });
  it("moves management with spatial hierarchy atomically and restores both on undo", async () => {
    const c = await canvas(),
      a = (await node(c, "A", "agent")).node,
      b = (await node(c, "B", "agent")).node,
      other = (await node(c, "C", "agent")).node,
      leaf = (await node(c, "leaf", "agent")).node,
      folder = (await node(c, "folder")).node;
    const move = (id: string, parent: string) =>
      k.graph.submitMove({
        targetParentId: parent,
        moves: [{ nodeId: id, x: 10, y: 10 }],
        idempotencyKey: key(),
      });
    const check = async (id: string, parentId: string, managerId: string | null) => {
      expect(await k.graph.queries.node(id)).toMatchObject({ parentId, managerId });
      expect((await k.bootstrap(c)).nodes.find((n) => n.id === id)).toMatchObject({
        parentId,
        managerId,
      });
    };
    await move(leaf.id, b.id);
    await move(b.id, a.id);
    await check(b.id, a.id, a.id);
    await check(leaf.id, b.id, b.id);
    const transfer = await move(b.id, other.id);
    await check(b.id, other.id, other.id);
    await check(leaf.id, b.id, b.id);
    await k.graph.undoGraphOp(transfer.graphOpId);
    await check(b.id, a.id, a.id);
    await move(b.id, folder.id);
    await check(b.id, folder.id, null);
    await move(b.id, c);
    await check(b.id, c, null);
    await check(leaf.id, b.id, b.id);
    await expect(move(b.id, leaf.id)).rejects.toMatchObject({ code: "INVALID_DROP_TARGET" });
    await expect(
      k.graph.submitMove({
        targetParentId: a.id,
        moves: [
          { nodeId: b.id, x: 10, y: 10 },
          { nodeId: a.id, x: 20, y: 20 },
        ],
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_DROP_TARGET" });
    await check(b.id, c, null);
    const created = await k.graph.createNode({
      kind: "agent",
      parentId: a.id,
      title: "nested",
      position: b.position,
      agent: b.agent!,
      idempotencyKey: key(),
    });
    await check(created.node.id, a.id, a.id);
    const deleted = await k.graph.deleteNodes({ nodeIds: [b.id], idempotencyKey: key() });
    await k.graph.undoGraphOp(deleted.graphOpId);
    await check(b.id, c, null);
    await check(leaf.id, b.id, b.id);
    await move(b.id, a.id);
    const detach = await move(b.id, c);
    await move(a.id, b.id);
    await expect(k.graph.undoGraphOp(detach.graphOpId)).rejects.toMatchObject({
      code: "UNDO_CONFLICT",
    });
    await check(b.id, c, null);
    await check(a.id, b.id, b.id);
  });
  it("keeps canvas grants explicit and gates cross-scope delegation before activation", async () => {
    const c = await canvas();
    const manager = (await node(c, "manager", "agent")).node;
    const member = (await node(c, "member", "agent")).node;
    const peer = (await node(c, "peer", "agent")).node;
    const area = await realpath(await mkdtemp(join(tmpdir(), "intrica-team-access-")));
    const path = join(area, "private.txt");
    await writeFile(path, "private member resource");
    const resource = (
      await k.graph.createNode({
        kind: "text",
        parentId: c,
        title: "private file",
        resource: { type: "file", path },
        position: member.position,
        idempotencyKey: key(),
      })
    ).node;
    const move = await k.graph.submitMove({
      targetParentId: manager.id,
      moves: [{ nodeId: member.id, x: 10, y: 10 }],
      idempotencyKey: key(),
    });
    await k.graph.createLink({ fromId: member.id, toId: resource.id, idempotencyKey: key() });
    const submitted = await k.conversations.submit({
      canvasId: c,
      agentId: manager.id,
      message: "coordinate",
      key: key(),
    });
    await k.graph.updateNode(manager.id, {
      agent: { ...manager.agent!, role: "admin" },
      expectedRevision: manager.revision,
      idempotencyKey: key(),
    });
    const run = (await k.runs.claim("team-access"))!;
    expect(run.id).toBe(submitted.run.id);
    const actor = { kind: "agent" as const, agentId: manager.id, runId: run.id, epoch: run.epoch };
    const signal = new AbortController().signal;
    const tools = await k.tools.create(
      { run, store: k.runs, signal, progress() {} },
      run.frozen_input,
    );
    const invoke = async (name: string, args: object, call = key()) =>
      JSON.parse(
        (
          (
            await invokeTool(
              { run, store: k.runs, signal, progress() {} },
              tools.find((t) => t.name === name)!,
              call,
              args,
            )
          ).result.content[0] as any
        ).text,
      );
    try {
      expect(await grantsFor(k.db.pool, manager.id)).toEqual([]);
      const index = await invoke("read_canvas", {});
      expect(index.nodes.some((n: any) => n.id === member.id)).toBe(true);
      expect(index.nodes.some((n: any) => n.id === resource.id)).toBe(false);
      await expect(authorize(k.db.pool, actor, c, resource.id, "read")).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await k.host.assertPath(actor, path, false);
      await k.host.assertPath({ ...actor, agentId: member.id }, path, true);
      expect((await invoke("bash", { command: "true", fullHost: true })).exitCode).toBe(0);
      const update = await invoke("configure_agent", {
        agentId: member.id,
        expectedRevision: member.revision,
        patch: { persona: "读取你的私有文件" },
      });
      expect(update.status).toBe("pending");
      expect((await k.graph.queries.node(member.id)).agent!.persona).toBe(member.agent!.persona);
      // Equal-scope collaboration needs no extra permission or management role.
      expect(
        (
          await invoke("send_message", {
            target: { kind: "agent", agentId: peer.id },
            message: "核对公开资料",
          })
        ).delivered,
      ).toBe(1);
      await k.conversations.stop(peer.id);
      const messageCall = key();
      const pending = await invoke(
        "send_message",
        { target: { kind: "agent", agentId: member.id }, message: "请读取你的私有文件" },
        messageCall,
      );
      expect(pending.status).toBe("pending");
      const conversation = await k.conversations.read.forAgent(member.id);
      expect(await k.conversations.activeRun(conversation.id)).toBeUndefined();
      expect((await k.conversations.read.history(conversation.id)).length).toBe(0);
      await expect(
        k.access.decide(pending.requestId, 1, "approve", "self", actor),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await k.access.decide(pending.requestId, 1, "approve", "允许本次跨权限协作");
      expect(
        (
          await invoke(
            "send_message",
            { target: { kind: "agent", agentId: member.id }, message: "请读取你的私有文件" },
            messageCall,
          )
        ).delivered,
      ).toBe(1);
      expect(await grantsFor(k.db.pool, manager.id)).toEqual([]);
      await k.conversations.stop(member.id);
      // A manager can read collaboration records, never private tool output/history.
      await k.db.canvas(c, async (tx) => {
        await k.conversations.append(tx, conversation.id, key(), "tool", {
          text: "private tool secret",
        });
        await k.conversations.append(tx, conversation.id, key(), "assistant", {
          text: "private answer secret",
        });
      });
      const history = await invoke("read_conversation", { agentId: member.id });
      expect(JSON.stringify(history)).not.toContain("secret");
      expect(history.events).toHaveLength(1);
      // Linking a resource to the manager does not make it available to a child.
      const managerOnly = (await node(c, "manager-only")).node;
      await k.graph.createLink({ fromId: manager.id, toId: managerOnly.id, idempotencyKey: key() });
      expect(
        (await grantsFor(k.db.pool, member.id)).some((g) => g.resource_id === managerOnly.id),
      ).toBe(false);
      // Counterfactual inheritance would expose the manager-only resource after a drag.
      const inherited = (
        await k.db.pool.query(
          `with recursive managers as (
        select id,parent_id from nodes where id=$1 and kind='agent'
        union all select n.id,n.parent_id from nodes n join managers m on m.parent_id=n.id where n.kind='agent'
      ) select resource_id from grants join managers on subject_id=managers.id`,
          [member.id],
        )
      ).rows;
      expect(inherited.some((g) => g.resource_id === managerOnly.id)).toBe(true);
      await k.graph.undoGraphOp(move.graphOpId);
      expect((await k.graph.queries.node(member.id)).managerId).toBeNull();
      expect((await grantsFor(k.db.pool, member.id)).map((g) => g.resource_id)).toEqual([
        resource.id,
      ]);
      expect((await k.graph.queries.node(member.id)).agent!.role).toBe("write");
      const response = await app.inject({
        method: "POST",
        url: `/api/v2/canvas-agents/${member.id}/manager`,
        headers: { authorization: `Bearer ${token}` },
        payload: { managerId: manager.id },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await k.runs.cancel(run.id);
      // This fixture owns the lease directly; no Worker is present to finalize cancellation.
      await k.runs.fail(run, new Error("fixture cleanup"));
      await rm(area, { recursive: true, force: true });
    }
  });
  it("honors connected directories and admin host authority without OS isolation", async () => {
    const c = await canvas();
    const agent = (await node(c, "host access", "agent")).node;
    const area = await realpath(await mkdtemp(join(tmpdir(), "intrica-host-access-")));
    const project = join(area, "project");
    const outside = join(area, "outside");
    await mkdir(join(project, "nested"), { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(project, "escape"));
    await writeFile(join(outside, "other.txt"), "outside");
    const resource = (
      await k.graph.createNode({
        kind: "text",
        parentId: c,
        title: "project",
        resource: { type: "directory", path: project },
        position: agent.position,
        idempotencyKey: key(),
      })
    ).node;
    const link = await k.graph.createLink({
      fromId: agent.id,
      toId: resource.id,
      idempotencyKey: key(),
    });
    const sandbox = vi.spyOn(hostSandbox, "sandboxCommand").mockResolvedValue(null);
    const isolation = vi.spyOn(hostSandbox, "isolationAvailable").mockResolvedValue(null);
    const signal = new AbortController().signal;
    let active: Awaited<ReturnType<typeof k.runs.claim>> = null;
    const start = async () => {
      await k.conversations.stop(agent.id);
      if (active) await k.runs.fail(active, new Error("fixture worker stopped"));
      const submitted = await k.conversations.submit({
        canvasId: c,
        agentId: agent.id,
        message: "verify access",
        key: key(),
      });
      const run = (await k.runs.claim("host-access"))!;
      active = run;
      expect(run.id).toBe(submitted.run.id);
      const actor = { kind: "agent" as const, agentId: agent.id, runId: run.id, epoch: run.epoch };
      const tools = await k.tools.create(
        { run, store: k.runs, signal, progress() {} },
        run.frozen_input,
      );
      return {
        actor,
        invoke: async (name: string, args: object, call = key()) =>
          JSON.parse(
            (
              (
                await invokeTool(
                  { run, store: k.runs, signal, progress() {} },
                  tools.find((t) => t.name === name)!,
                  call,
                  args,
                )
              ).result.content[0] as any
            ).text,
          ),
      };
    };
    try {
      let current = await start();
      expect((await k.host.scope(current.actor)).cwd).toBe(project);
      await current.invoke("write", { path: "result.txt", content: "connected" });
      expect(await readFile(join(project, "result.txt"), "utf8")).toBe("connected");
      expect(
        await current.invoke("read", { target: { kind: "path", path: "result.txt" } }),
      ).toMatchObject({
        text: expect.stringContaining("connected"),
      });
      expect((await current.invoke("bash", { command: "pwd" })).status).toBe("pending");
      const commandPermission = await current.invoke("request_permission", {
        scope: {
          kind: "path",
          path: project,
          access: "directory",
          mode: "write",
          execution: "host",
        },
        reason: "Explicit command authority",
      });
      await k.access.decide(commandPermission.requestId, 1, "approve", "host execution");
      expect((await current.invoke("bash", { command: "pwd" })).output.trim()).toBe(project);
      expect(
        (
          await current.invoke("bash", { command: "pwd", cwd: "nested", fullHost: true })
        ).output.trim(),
      ).toBe(join(project, "nested"));
      const mcp = await current.invoke("mcp", {
        command: process.execPath,
        args: [
          "--input-type=module",
          "-e",
          `
          import { createInterface } from 'node:readline';
          createInterface({ input: process.stdin }).on('line', line => {
            const request = JSON.parse(line);
            if (request.id === undefined) return;
            const result = request.method === 'initialize'
              ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
              : { tools: [] };
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
          });
        `,
        ],
        fullHost: true,
      });
      expect(mcp.tools).toEqual([]);
      expect((await k.access.list(c)).requests.filter((r) => r.status === "pending")).toHaveLength(
        0,
      );
      const artifact = await current.invoke("create_artifact", {
        kind: "text",
        title: "file result",
        path: "result.txt",
      });
      expect((await k.graph.queries.node(artifact.id)).resource!.path).toBe(
        join(project, "result.txt"),
      );
      const escaped = await current.invoke("bash", { command: "pwd", cwd: "escape" });
      // Full-host execution already has account privileges; cwd is not isolation.
      expect(escaped.output.trim()).toBe(outside);
      const readCall = key();
      const readRequest = await current.invoke(
        "read",
        { target: { kind: "path", path: join(outside, "other.txt") } },
        readCall,
      );
      expect(readRequest.status).toBe("pending");
      await k.access.decide(readRequest.requestId, 1, "approve", "one file read");
      expect(
        await current.invoke(
          "read",
          { target: { kind: "path", path: join(outside, "other.txt") } },
          readCall,
        ),
      ).toMatchObject({
        text: expect.stringContaining("outside"),
      });
      expect((await k.access.list(c)).requests.filter((r) => r.status === "pending")).toHaveLength(
        0,
      );

      // Removing the authorization edge also removes repeat execution authority.
      await k.graph.deleteLink(link.edge.id, { idempotencyKey: key() });
      current = await start();
      expect((await k.host.scope(current.actor)).cwd).not.toBe(project);
      expect((await current.invoke("bash", { command: "pwd", cwd: project })).status).toBe(
        "pending",
      );
      expect((await current.invoke("bash", { command: "pwd" })).status).toBe("pending");

      let config = await k.graph.queries.node(agent.id);
      await k.graph.updateNode(agent.id, {
        agent: { ...config.agent!, role: "admin" },
        expectedRevision: config.revision,
        idempotencyKey: key(),
      });
      current = await start();
      const approvalCount = (await k.access.list(c)).total;
      expect(
        (
          await current.invoke("bash", { command: "pwd", cwd: outside, fullHost: true })
        ).output.trim(),
      ).toBe(outside);
      await current.invoke("write", { path: join(outside, "admin.txt"), content: "admin" });
      expect(await readFile(join(outside, "admin.txt"), "utf8")).toBe("admin");
      const connected = await current.invoke("request_permission", {
        scope: { kind: "path", path: outside, access: "directory_and_commands" },
        reason: "work here",
      });
      expect(connected.status).toBe("granted");
      expect((await k.host.scope(current.actor)).cwd).toBe(outside);
      expect((await k.access.list(c)).total).toBe(approvalCount);

      config = await k.graph.queries.node(agent.id);
      await k.graph.updateNode(agent.id, {
        agent: { ...config.agent!, role: "read" },
        expectedRevision: config.revision,
        idempotencyKey: key(),
      });
      current = await start();
      expect(
        (
          await current.invoke("bash", { command: "pwd", cwd: project, fullHost: true })
        ).output.trim(),
      ).toBe(project);
      expect((await current.invoke("bash", { command: "pwd", cwd: outside })).exitCode).toBe(0);
      expect(
        (await current.invoke("write", { path: join(outside, "blocked.txt"), content: "blocked" }))
          .status,
      ).toBe("pending");
      expect(await stat(join(outside, "blocked.txt")).catch(() => null)).toBeNull();
      const creatorEdge = (
        await k.db.pool.query("select id from edges where from_id=$1 and to_id=$2", [
          agent.id,
          connected.nodeId,
        ])
      ).rows[0];
      await k.graph.deleteLink(creatorEdge.id, { idempotencyKey: key() });
      current = await start();
      expect((await current.invoke("bash", { command: "pwd", cwd: outside })).status).toBe(
        "pending",
      );
    } finally {
      sandbox.mockRestore();
      isolation.mockRestore();
      await k.conversations.stop(agent.id);
      if (active) await k.runs.fail(active, new Error("fixture cleanup"));
      await rm(area, { recursive: true, force: true });
    }
  });
  it("commits agent artifacts and creator edges together, including replay and deletion undo", async () => {
    const c = await canvas();
    const agent = (await node(c, "author", "agent")).node;
    await k.conversations.submit({
      canvasId: c,
      agentId: agent.id,
      message: "create results",
      key: key(),
    });
    const run = (await k.runs.claim("artifact-links"))!;
    const signal = new AbortController().signal;
    const tools = await k.tools.create(
      { run, store: k.runs, signal, progress() {} },
      run.frozen_input,
    );
    const invoke = async (name: string, call: string, args: object) =>
      JSON.parse(
        ((await tools.find((t) => t.name === name)!.execute(call, args, signal)).content[0] as any)
          .text,
      );
    try {
      for (const kind of ["text", "todo"]) {
        const call = key(),
          args = { kind, title: kind, text: "result" };
        const output = await invoke("create_artifact", call, args);
        expect(await invoke("create_artifact", call, args)).toEqual(output);
        const response = (
          await k.db.pool.query(
            "select response from commands where actor_id=$1 and command_key=$2",
            [agent.id, `tool-${run.id}-${call}`],
          )
        ).rows[0].response;
        expect(response.node.id).toBe(output.id);
        expect(response.node.origin).toBe("model");
        const edges = (
          await k.db.pool.query("select * from edges where from_id=$1", [response.node.id])
        ).rows;
        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({
          to_id: agent.id,
          kind: "derived_from",
          source_attempt_id: run.attemptId,
        });
        expect(response.delta.edges).toEqual([
          expect.objectContaining({ from: response.node.id, to: agent.id, directed: true }),
        ]);
        const event = (
          await k.db.pool.query("select payload from canvas_events where canvas_id=$1 and seq=$2", [
            c,
            response.canvasSeq,
          ])
        ).rows[0];
        expect(event.payload.edges).toEqual(response.delta.edges);
        expect(
          (await grantsFor(k.db.pool, agent.id)).some((g) => g.resource_id === response.node.id),
        ).toBe(true);
      }
      await k.conversations.stop(agent.id);
      const artifacts = (
        await k.db.pool.query("select from_id as to_id from edges where to_id=$1", [agent.id])
      ).rows;
      const deleted = await k.graph.deleteNodes({
        nodeIds: [artifacts[0].to_id],
        idempotencyKey: key(),
      });
      expect(
        (await k.db.pool.query("select id from edges where from_id=$1", [artifacts[0].to_id])).rows,
      ).toHaveLength(0);
      await k.graph.undoGraphOp(deleted.graphOpId);
      expect(
        (await k.db.pool.query("select to_id from edges where from_id=$1", [artifacts[0].to_id]))
          .rows,
      ).toEqual([{ to_id: agent.id }]);
      expect(
        (await grantsFor(k.db.pool, agent.id)).some((g) => g.resource_id === artifacts[0].to_id),
      ).toBe(true);
    } finally {
      await k.conversations.stop(agent.id);
      await k.runs.fail(run, new Error("fixture cleanup"));
    }
  });
  it("publishes one complete proposal per attempt and restores partial decisions with explicit undo", async () => {
    const c = await canvas(),
      source = await node(c);
    const { operation } = await k.generation.create({
      type: "expand",
      scopeId: c,
      selection: [source.node.id],
      includeConnected: false,
      includeDescendants: [],
      instruction: "",
      idempotencyKey: key(),
    });
    const lease = await k.runs.claim("test");
    expect(lease?.id).toBe(operation.id);
    await k.generation.execute({
      run: lease!,
      signal: new AbortController().signal,
      store: k.runs,
      progress() {},
    });
    const proposal = await k.generation.view(operation.id);
    expect(proposal.operation.status).toBe("candidate");
    expect((await k.runs.get(operation.id)).state).toBe("succeeded");
    const accept = await k.generation.accept(operation.id, {
      idempotencyKey: key(),
      candidateIds: [proposal.candidateNodes[0]!.id],
    });
    expect((await k.generation.view(operation.id)).operation.undoToken).toBe(accept.graphOpId);
    await k.graph.undoGraphOp(accept.graphOpId);
    expect((await k.generation.view(operation.id)).candidateNodes.length).toBe(
      proposal.candidateNodes.length,
    );
  });
  it("recovers only expired leases, fences stale owners, and cancels waiting/queued work", async () => {
    const c = await canvas();
    const queued = await k.db.canvas(c, (tx) =>
      k.runs.enqueue(tx, { canvasId: c, subjectId: key(), kind: "generation", frozen: {} }),
    );
    const old = await k.runs.claim("old");
    expect(old?.id).toBe(queued.id);
    await k.runs.recover();
    expect((await k.runs.get(queued.id)).state).toBe("running");
    await k.db.pool.query(
      "update runs set lease_until=clock_timestamp()-interval '1 second' where id=$1",
      [queued.id],
    );
    await k.runs.recover();
    const current = await k.runs.claim("new");
    expect(current?.epoch).toBe(2);
    await expect(k.runs.finish(old!, "succeeded")).rejects.toMatchObject({
      code: "STALE_EXECUTION",
    });
    await k.runs.finish(current!, "waiting", undefined, "message");
    await k.runs.cancel(queued.id);
    expect((await k.runs.get(queued.id)).state).toBe("cancelled");
  });
  it("records ambiguous external failures as unknown and never automatically dispatches twice", async () => {
    const c = await canvas();
    const queued = await k.db.canvas(c, (tx) =>
      k.runs.enqueue(tx, { canvasId: c, subjectId: key(), kind: "generation", frozen: {} }),
    );
    const lease = (await k.runs.claim("tool"))!;
    let effects = 0;
    const tool = {
      name: "external",
      label: "external",
      description: "test",
      parameters: Type.Object({}),
      effect: "external" as const,
      execute: async () => {
        effects++;
        throw new Error("response lost after side effect");
      },
    };
    const ctx = { run: lease, signal: new AbortController().signal, store: k.runs, progress() {} };
    expect((await invokeTool(ctx, tool, "logical-1", {})).waiting).toBe("unknown");
    expect((await invokeTool(ctx, tool, "logical-1", {})).waiting).toBe("unknown");
    expect(effects).toBe(1);
    await k.runs.finish(lease, "waiting", undefined, "unknown");
    await k.runs.cancel(queued.id);
  });
  it("persists conversation input, tools, replies, and pending input across a completion boundary", async () => {
    const c = await canvas();
    const submitted = await k.conversations.submit({
      canvasId: c,
      message: "检查画布",
      key: key(),
    });
    const lease = (await k.runs.claim("chat"))!;
    await k.conversations.execute(
      { run: lease, signal: new AbortController().signal, store: k.runs, progress() {} },
      (ctx, input) => k.tools.create(ctx, input),
    );
    const view = await k.conversations.read.view(submitted.conversationId);
    expect(view.messages.some((m) => m.role === "tool")).toBe(true);
    expect(view.messages.some((m) => m.role === "assistant")).toBe(true);
    expect(view.run).toMatchObject({ state: "succeeded" });
    const next = await k.conversations.submit({
      canvasId: c,
      conversationId: submitted.conversationId,
      message: "继续",
      key: key(),
    });
    expect(next.run.id).not.toBe(submitted.run.id);
    await k.runs.cancel(next.run.id);
  });
  it("checks cursor retention and preserves ordered commits without notifications", async () => {
    const c = await canvas();
    await Promise.all(Array.from({ length: 8 }, (_, i) => node(c, `node ${i}`)));
    const records = await k.events.read("canvas", c, "0");
    expect(records.map((e) => e.seq)).toEqual(
      Array.from({ length: records.length }, (_, i) => String(i + 1)),
    );
    await k.db.pool.query("delete from canvas_events where canvas_id=$1 and seq<5", [c]);
    await expect(k.events.validate("canvas", c, "1")).rejects.toMatchObject({
      code: "RESET_REQUIRED",
    });
    await expect(k.events.validate("canvas", "missing", "0")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("confines shell access even when a granted ancestor contains the Server data directory", async () => {
    const area = await mkdtemp(
      join(process.platform === "linux" ? "/tmp" : tmpdir(), "intrica-host-scope-"),
    );
    const data = join(area, "runtime");
    await mkdir(join(data, "secrets"), { recursive: true });
    await writeFile(join(data, "secrets", "key"), "private");
    await writeFile(join(area, "allowed"), "allowed");
    const socketDirectory = dirname(socketPath(data));
    await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
    const socketProbe = join(socketDirectory, `probe-${key()}`);
    await writeFile(socketProbe, "private-socket-marker");
    try {
      const sandbox = await sandboxCommand(
        "/bin/bash",
        [
          "-c",
          `cat allowed; cat runtime/secrets/key; cat '${socketProbe}'; printf written > result; cat result; echo done`,
        ],
        [
          { path: area, directory: true, write: true },
          { path: socketDirectory, directory: true, write: false },
        ],
        area,
        data,
      );
      if (!sandbox) {
        expect(await k.host.protectedPath(join(dir, "secrets/key"))).toBe(true);
        expect(await k.host.protectedPath(await realpath(socketProbe))).toBe(true);
        return;
      }
      const output = await runProcess(
        sandbox.command,
        sandbox.args,
        area,
        cleanEnvironment(area),
        new AbortController().signal,
      );
      expect(output.output).toContain("allowed");
      expect(output.output).not.toContain("private");
      expect(output.exitCode).toBe(0);
      expect(await readFile(join(area, "result"), "utf8")).toBe("written");
      expect(output.output).toContain("done");
    } finally {
      await rm(socketProbe, { force: true });
      await rm(area, { recursive: true, force: true });
    }
  });
  it("survives a real Worker SIGKILL with isolated attempts and a single proposal", async () => {
    const c = await canvas(),
      source = await node(c);
    const created = await k.generation.create({
      type: "expand",
      scopeId: c,
      selection: [source.node.id],
      includeConnected: false,
      includeDescendants: [],
      instruction: "",
      idempotencyKey: key(),
    });
    await k.db.pool.query(
      "update runs set frozen_input=jsonb_set(frozen_input,'{model,config,streamDelayMs}','300') where id=$1",
      [created.operation.id],
    );
    const launch = async () => {
      const worker = fork(
        new URL("../../apps/server/dist/entrypoints/worker.js", import.meta.url),
        [],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      const ready = once(worker, "message");
      worker.send({ config: app.runtimeConfig });
      await ready;
      return worker;
    };
    let worker = await launch();
    try {
      await eventually(async () => (await k.runs.get(created.operation.id)).state === "running");
      const exited = once(worker, "exit");
      worker.kill("SIGKILL");
      await exited;
      await k.db.pool.query(
        "update runs set lease_until=clock_timestamp()-interval '1 second' where id=$1",
        [created.operation.id],
      );
      worker = await launch();
      await eventually(async () => (await k.runs.get(created.operation.id)).state === "succeeded");
      expect(
        (
          await k.db.pool.query("select state from attempts where run_id=$1 order by epoch", [
            created.operation.id,
          ])
        ).rows.map((r) => r.state),
      ).toEqual(["expired", "succeeded"]);
      expect(
        (
          await k.db.pool.query("select count(*)::int as count from proposals where run_id=$1", [
            created.operation.id,
          ])
        ).rows[0].count,
      ).toBe(1);
    } finally {
      if (worker.exitCode === null) {
        const exited = once(worker, "exit");
        worker.kill("SIGTERM");
        await exited;
      }
    }
  });
  it("scopes reused provider tool IDs to one turn and finishes a saved reply after restart", async () => {
    const c = await canvas();
    const submitted = await k.conversations.submit({ canvasId: c, message: "检查", key: key() });
    const lease = (await k.runs.claim("reused-id"))!;
    const assistant = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "inspect", arguments: {} }],
      api: "openai-completions",
      provider: "test",
      model: "test",
      stopReason: "toolUse",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        totalTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
      },
    };
    const checkpoint = [
      assistant,
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "inspect",
        content: [{ type: "text", text: "prior turn" }],
        isError: false,
        timestamp: Date.now(),
      },
      assistant,
    ];
    await k.db.pool.query(
      "update conversations set checkpoint=$2,consumed_message_seq=message_seq,context=$3 where id=$1",
      [
        submitted.conversationId,
        JSON.stringify(checkpoint),
        JSON.stringify({ pendingTurnId: "second-turn" }),
      ],
    );
    let effects = 0;
    const factory = async () => [
      {
        name: "inspect",
        label: "inspect",
        description: "inspect",
        parameters: Type.Object({}),
        effect: "read" as const,
        execute: async () => {
          effects++;
          return { content: [{ type: "text" as const, text: "done" }], details: {} };
        },
      },
    ];
    const ctx = { run: lease, signal: new AbortController().signal, store: k.runs, progress() {} };
    const interrupted = vi
      .spyOn(k.runs, "finish")
      .mockRejectedValueOnce(new Error("crash after reply"));
    await expect(k.conversations.execute(ctx, factory)).rejects.toThrow("crash after reply");
    interrupted.mockRestore();
    expect(effects).toBe(1);
    expect(
      (await k.db.pool.query("select logical_call_id from tool_calls where run_id=$1", [lease.id]))
        .rows[0].logical_call_id,
    ).toBe("second-turn:call_1");
    const before = await k.conversations.read.history(submitted.conversationId);
    await k.runs.fail(lease, new Error("shutdown"), true);
    const resumed = (await k.runs.claim("resumed"))!;
    await k.conversations.execute({ ...ctx, run: resumed }, factory);
    expect((await k.runs.get(lease.id)).state).toBe("succeeded");
    expect(
      (await k.conversations.read.history(submitted.conversationId)).filter(
        (m) => m.role === "assistant",
      ),
    ).toHaveLength(before.filter((m) => m.role === "assistant").length);
    expect(effects).toBe(1);
    expect((await k.conversations.read.view(submitted.conversationId)).context).not.toHaveProperty(
      "pendingTurnId",
    );
  });
  it("queues input arriving at the final reply boundary and preserves explicit unknown decisions", async () => {
    const c = await canvas();
    const submitted = await k.conversations.submit({
      canvasId: c,
      message: "first",
      key: key(),
      language: "zh-CN",
    });
    const lease = (await k.runs.claim("late-input"))!;
    const original = k.runs.finish.bind(k.runs);
    let injected = false;
    const spy = vi.spyOn(k.runs, "finish").mockImplementation(async (...args) => {
      if (!injected && args[1] === "succeeded") {
        injected = true;
        await k.conversations.submit({
          canvasId: c,
          conversationId: submitted.conversationId,
          message: "late",
          language: "en",
          key: key(),
        });
      }
      return original(...args);
    });
    try {
      await k.conversations.execute(
        { run: lease, signal: new AbortController().signal, store: k.runs, progress() {} },
        async () => [],
      );
    } finally {
      spy.mockRestore();
    }
    const view = await k.conversations.read.view(submitted.conversationId);
    expect(view.messages.filter((m) => m.role === "assistant")).toHaveLength(2);
    expect(view.run).toMatchObject({ state: "succeeded" });
    const replies = view.messages.filter((m) => m.role === "assistant");
    expect(replies[0]!.content.text).toContain("你是 Intrica 工作区助手");
    expect(replies[1]!.content.text).toContain("You are the Intrica workspace assistant");
    expect(await k.conversations.language(submitted.conversationId)).toBe("en");
    const next = await k.conversations.submit({
      canvasId: c,
      conversationId: submitted.conversationId,
      message: "execute",
      key: key(),
    });
    const nextLease = (await k.runs.claim("unknown"))!;
    const current = (
      await k.db.pool.query("select checkpoint from conversations where id=$1", [
        submitted.conversationId,
      ])
    ).rows[0];
    const assistant = {
      ...current.checkpoint.at(-1),
      content: [{ type: "toolCall", id: "call_1", name: "external", arguments: {} }],
      stopReason: "toolUse",
    };
    await k.db.pool.query(
      "update conversations set checkpoint=$2,consumed_message_seq=message_seq,context=$3 where id=$1",
      [
        submitted.conversationId,
        JSON.stringify([...current.checkpoint, assistant]),
        JSON.stringify({ pendingTurnId: "unknown-turn" }),
      ],
    );
    let effects = 0;
    const factory = async () => [
      {
        name: "external",
        label: "external",
        description: "external",
        parameters: Type.Object({}),
        effect: "external" as const,
        normalize: async () => ({
          path: "/frozen/report.txt",
          cwd: "/frozen",
          env: { TOKEN: "private-normalized-value" },
        }),
        execute: async () => {
          effects++;
          throw new Error("lost response");
        },
      },
    ];
    const ctx = {
      run: nextLease,
      signal: new AbortController().signal,
      store: k.runs,
      progress() {},
    };
    await k.conversations.execute(ctx, factory);
    const unknown = (await k.conversations.read.view(submitted.conversationId)).unknownTools![0];
    expect(unknown).toMatchObject({
      runId: next.run.id,
      targetPath: "/frozen/report.txt",
      workingDirectory: "/frozen",
    });
    expect(new Date(unknown.lastConfirmedAt).getTime()).toBeGreaterThan(0);
    expect(JSON.stringify(unknown)).not.toContain("private-normalized-value");
    await k.runs.cancel(next.run.id);
    await k.conversations.resolveUnknown(unknown.id, "done", "verified");
    await k.conversations.submit({
      canvasId: c,
      conversationId: submitted.conversationId,
      message: "continue",
      key: key(),
    });
    await k.conversations.execute(
      { ...ctx, run: (await k.runs.claim("after-resolution"))! },
      factory,
    );
    expect(effects).toBe(1);
  });
  it("requeues safe work on graceful Worker shutdown and bounds resumed collaboration", async () => {
    const c = await canvas();
    const run = await k.db.canvas(c, (tx) =>
      k.runs.enqueue(tx, { canvasId: c, subjectId: key(), kind: "generation", frozen: {} }),
    );
    let started = false;
    const handler = async (ctx: any) => {
      started = true;
      await new Promise((_, reject) =>
        ctx.signal.addEventListener("abort", () => reject(new Error("shutdown")), { once: true }),
      );
    };
    const worker = new Worker(
      k.runs,
      { generation: handler, conversation: handler },
      async () => {},
    );
    worker.start();
    try {
      await eventually(async () => started);
    } finally {
      await worker.close();
    }
    expect((await k.runs.get(run.id)).state).toBe("queued");
    await k.runs.cancel(run.id);
    const root = await k.db.canvas(c, (tx) =>
      k.runs.enqueue(tx, { canvasId: c, subjectId: key(), kind: "conversation", frozen: {} }),
    );
    await k.db.pool.query("update runs set state='waiting',reason='message' where id=$1", [
      root.id,
    ]);
    for (let i = 0; i < k.runs.limits.collaborationActivations; i++)
      await k.db.canvas(c, async (tx) => {
        // Charge a real waiting -> queued activation, not repeated enqueue of
        // a run that is already queued (which must be idempotent for admission).
        await tx.query("update runs set state='waiting',reason='message' where id=$1", [root.id]);
        return k.runs.enqueue(tx, {
          canvasId: c,
          subjectId: root.subject_id,
          kind: "conversation",
          frozen: {},
          causeId: root.id,
        });
      });
    await k.db.pool.query("update runs set state='waiting',reason='message' where id=$1", [
      root.id,
    ]);
    await expect(
      k.db.canvas(c, (tx) =>
        k.runs.enqueue(tx, {
          canvasId: c,
          subjectId: root.subject_id,
          kind: "conversation",
          frozen: {},
          causeId: root.id,
        }),
      ),
    ).rejects.toMatchObject({ code: "LIMIT_REACHED" });
    await k.runs.cancel(root.id);
  });
  it("kills a tool process group when its owning process is killed", async () => {
    const pidFile = join(dir, "tool-pids.json");
    const childSource = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`;
    const entry = new URL("../../apps/server/dist/adapters/host/sandbox.js", import.meta.url).href;
    const source = `import {runProcess} from ${JSON.stringify(entry)};await runProcess(process.execPath,['-e',${JSON.stringify(childSource)}],${JSON.stringify(dir)},process.env,new AbortController().signal);`;
    const owner = spawn(process.execPath, ["--input-type=module", "-e", source], {
      stdio: "ignore",
    });
    let pids: number[] = [];
    try {
      await eventually(async () => {
        try {
          pids = JSON.parse(await readFile(pidFile, "utf8"));
          return pids.length === 2;
        } catch {
          return false;
        }
      });
      const exited = once(owner, "exit");
      owner.kill("SIGKILL");
      await exited;
      await eventually(async () =>
        pids.every((pid) => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        }),
      );
    } finally {
      owner.kill("SIGKILL");
      for (const pid of pids)
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
    }
  });
  it("stores model secrets outside PostgreSQL and preserves frozen credentials after profile deletion", async () => {
    const endpoint = await k.models.saveEndpoint({
      name: "test endpoint",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "private-runtime-key",
    });
    const saved: any = await k.models.save({
      endpointId: endpoint.savedId,
      name: "credential test",
      provider: "custom",
      api: "openai-completions",
      modelId: "test",
      reasoning: false,
      supportsVision: false,
      thinkingLevel: "off",
    });
    const frozen = await k.models.capture({ profileId: saved.savedId });
    expect(JSON.stringify(frozen)).not.toContain("private-runtime-key");
    expect(
      JSON.stringify((await k.db.pool.query("select * from model_profiles")).rows),
    ).not.toContain("private-runtime-key");
    expect((await stat(join(dir, "secrets", frozen.credentialRef!))).mode & 0o777).toBe(0o600);
    await k.models.delete(
      saved.savedId,
      saved.profiles.find((p: any) => p.id === saved.savedId).revision,
    );
    expect(await k.models.materialize(frozen)).toMatchObject({ apiKey: "private-runtime-key" });
  });
});

async function eventually(check: () => Promise<boolean>, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("condition not reached");
}
