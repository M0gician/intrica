import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { grantsFor } from "../../apps/server/dist/modules/access/policy.js";
import { invokeTool } from "../../apps/server/dist/modules/execution/tool-calls.js";

const key = () => randomUUID();
const adminUrl = process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres";
const dbName = `intrica_approvals_${key().replaceAll("-", "")}`;
const token = key();
let app: Awaited<ReturnType<typeof buildServer>>, k: Kernel, dir: string, area: string;
async function admin(sql: string) {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}
beforeAll(async () => {
  await admin(`create database ${dbName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  dir = await realpath(await mkdtemp(join(tmpdir(), "intrica-approval-data-")));
  area = await realpath(await mkdtemp(join(tmpdir(), "intrica-approval-files-")));
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
  await admin(`drop database if exists ${dbName} with(force)`);
  await rm(dir, { recursive: true, force: true });
  await rm(area, { recursive: true, force: true });
});
const canvas = async () =>
  (await k.graph.createCanvas({ title: "approval test", idempotencyKey: key() })).node.id;
const agent = async (parentId: string, role: "read" | "write" | "admin" = "read", enabled = true) =>
  (
    await k.graph.createNode({
      kind: "agent",
      parentId,
      title: key(),
      agent: { persona: "", role, enabled },
      position: { x: 0, y: 0, width: 220, height: 300 },
      idempotencyKey: key(),
    })
  ).node;
const resource = async (c: string, path?: string) =>
  (
    await k.graph.createNode({
      kind: "text",
      parentId: c,
      title: "resource",
      text: "hello",
      ...(path ? { resource: { type: "directory" as const, path } } : {}),
      position: { x: 0, y: 0, width: 220, height: 160 },
      idempotencyKey: key(),
    })
  ).node;
async function connect(a: string, r: string) {
  return k.graph.createLink({ fromId: a, toId: r, idempotencyKey: key() });
}
async function start(a: string) {
  const n = await k.graph.queries.node(a);
  const submitted = await k.conversations.submit({
    canvasId: n.canvasId!,
    agentId: a,
    message: "test",
    key: key(),
  });
  const run = (await k.runs.claim("approval-test"))!;
  expect(run.id).toBe(submitted.run.id);
  const ctx = { run, store: k.runs, signal: new AbortController().signal, progress() {} };
  const tools = await k.tools.create(ctx, run.frozen_input);
  return {
    run,
    actor: { kind: "agent" as const, agentId: a, runId: run.id, epoch: run.epoch },
    async call(name: string, args: object, logical = key()) {
      const response = await invokeTool(ctx, tools.find((t) => t.name === name)!, logical, args);
      const text = (response.result.content[0] as any).text;
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
async function request(id: string) {
  return (await k.db.pool.query("select * from approvals where id=$1", [id])).rows[0];
}
async function decide(
  id: string,
  actor?: Parameters<Kernel["access"]["decide"]>[4],
  decision: "approve" | "deny" | "escalate" = "approve",
) {
  return k.access.decide(id, (await request(id)).version, decision, "reviewed", actor);
}
describe("origin-bound approval lifecycle", () => {
  it("new directory grants separate file modes from execution and satisfy the original pending read", async () => {
    const c = await canvas(),
      a = await agent(c, "read"),
      child = await start(a.id);
    const path = join(area, `${key()}.txt`);
    await writeFile(path, "authorized bytes");
    const args = { target: { kind: "path", path } };
    const pending = await child.call("read", args);
    expect(pending.waiting).toBe("approval");
    const directory = await resource(c, area);
    const link = await connect(a.id, directory.id);
    const satisfied = await request(pending.value.requestId);
    expect(satisfied).toMatchObject({ status: "satisfied", decided_by: null });
    const resumed = await child.call("read", args, pending.logical);
    expect(resumed.value.text).toBe("authorized bytes");
    expect(
      (
        await k.db.pool.query(
          "select count(*)::int as n from tool_calls where run_id=$1 and logical_call_id=$2",
          [child.run.id, pending.logical],
        )
      ).rows[0].n,
    ).toBe(1);
    expect((await child.call("write", { path, content: "blocked" })).waiting).toBe("approval");
    expect((await child.call("bash", { command: "pwd", fullHost: true, cwd: area })).waiting).toBe(
      "approval",
    );
    expect(
      (await k.access.describe(a.id)).resources.find((r) => r.nodeId === directory.id),
    ).toMatchObject({ mode: "read", execution: "none" });
    await k.graph.deleteLink(link.edge.id, { idempotencyKey: key() });
    expect((await k.runs.get(child.run.id)).cancel_requested_at).not.toBeNull();
  });
  it("one-off reads and persistent paths use the same manager scratch ownership", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      b = await agent(m.id, "write");
    const manager = await start(m.id),
      child = await start(b.id);
    const path = join((await k.host.scope(manager.actor)).scratch, `${key()}.txt`);
    await writeFile(path, "manager bytes");
    const args = { target: { kind: "path", path } };
    const once = await child.call("read", args);
    expect((await request(once.value.requestId)).action.workspaceOwnerId).toBe(m.id);
    await decide(once.value.requestId, manager.actor);
    expect((await child.call("read", args, once.logical)).value.text).toBe("manager bytes");
    const ongoing = await child.call("request_permission", {
      scope: { kind: "path", path, access: "file", mode: "read" },
      reason: "Read the same owned file",
    });
    await decide(ongoing.value.requestId, manager.actor);
    expect((await child.call("read", args)).value.text).toBe("manager bytes");
  });
  it("existing authority never bypasses denial or a request escalated to the user", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      a = await agent(m.id, "write");
    const manager = await start(m.id),
      child = await start(a.id);
    const paths = [join(area, `${key()}.txt`), join(area, `${key()}.txt`)];
    for (const path of paths) await writeFile(path, "private");
    const denied = await child.call("read", { target: { kind: "path", path: paths[0] } });
    await decide(denied.value.requestId, undefined, "deny");
    const escalated = await child.call("read", { target: { kind: "path", path: paths[1] } });
    await decide(escalated.value.requestId, manager.actor, "escalate");
    await connect(a.id, (await resource(c, area)).id);
    expect((await request(denied.value.requestId)).status).toBe("denied");
    expect(await request(escalated.value.requestId)).toMatchObject({
      status: "pending",
      assigned_reviewer_id: null,
    });
  });
  it("T47 multimodal read uses the same frozen path approval and respects model capabilities", async () => {
    const c = await canvas(),
      a = await agent(c),
      child = await start(a.id);
    const path = join(area, `${key()}.txt`);
    await writeFile(
      path,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQMgkTMgljgFAAEA4CcV2GZ44AAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const pending = await child.call("read", { target: { kind: "path", path } });
    expect(pending.waiting).toBe("approval");
    expect(pending.result.content.every((p) => p.type !== "image")).toBe(true);
    await decide(pending.value.requestId);
    const resumed = await child.call("read", { target: { kind: "path", path } }, pending.logical);
    expect(resumed.result.content.some((p) => p.type === "image")).toBe(true);
    // A single approved read cannot silently become a persistent directory grant.
    expect((await child.call("read", { target: { kind: "path", path } })).waiting).toBe("approval");
    const scratch = (await k.host.scope(child.actor)).scratch;
    const local = join(scratch, "image-without-extension");
    await writeFile(local, await readFile(path));
    const ctx = {
      run: child.run,
      store: k.runs,
      signal: new AbortController().signal,
      progress() {},
    };
    const tools = await k.tools.create(ctx, {
      ...child.run.frozen_input,
      model: { config: { kind: "mock", streamDelayMs: 0, supportsVision: false } },
    });
    const noVision = await invokeTool(ctx, tools.find((t) => t.name === "read")!, key(), {
      target: { kind: "path", path: local },
    });
    expect(noVision.result.isError).toBe(true);
    expect(noVision.result.content.every((p) => p.type !== "image")).toBe(true);
    expect(JSON.stringify(noVision.result)).toContain("不支持图像");
    const textPath = join(scratch, "actually-text.png");
    await writeFile(textPath, "first\nsecond\nthird");
    expect(
      (await child.call("read", { target: { kind: "path", path: textPath }, line: 2 })).value,
    ).toMatchObject({ text: "second\nthird", nextCursor: null });
    expect(
      (await child.call("read", { target: { kind: "path", path: textPath }, frame: 0 })).result
        .isError,
    ).toBe(true);
  });
  it("T48 rg is a read capability with frozen approval, bounded results and no shell arguments", async () => {
    const c = await canvas(),
      a = await agent(c),
      child = await start(a.id);
    const root = join(area, key());
    await mkdir(root);
    await writeFile(join(root, "a.txt"), "needle one\nneedle two\n");
    await writeFile(join(root, ".private.txt"), "hidden needle");
    const outside = join(area, `${key()}.txt`);
    await writeFile(outside, "outside secret needle");
    await symlink(outside, join(root, "escaped.txt"));
    const args = { path: root, pattern: "needle", maxResults: 1 };
    const pending = await child.call("rg", args);
    expect(pending.waiting).toBe("approval");
    expect((await request(pending.value.requestId)).action).toMatchObject({
      kind: "host",
      tool: "rg",
    });
    await decide(pending.value.requestId);
    const found = await child.call("rg", args, pending.logical);
    expect(found.value.matches).toHaveLength(1);
    expect(found.value.truncated).toBe(true);
    expect(found.value.reasons).toContain("max_results");
    expect(JSON.stringify(found.value)).not.toContain("outside secret");
    expect(await grantsFor(k.db.pool, a.id)).toHaveLength(0);
    expect((await child.call("rg", args)).waiting).toBe("approval");
    const scratch = (await k.host.scope(child.actor)).scratch;
    await writeFile(join(scratch, "local.txt"), "local needle");
    expect((await child.call("rg", { path: scratch, pattern: "absent" })).value).toMatchObject({
      matches: [],
      truncated: false,
    });
    expect(
      (await child.call("rg", { path: scratch, pattern: "needle", flags: "--follow" })).result
        .isError,
    ).toBe(true);
    expect((await child.call("bash", { command: "true", fullHost: true })).waiting).toBe(
      "approval",
    );
  });
  it("T49 atomic text editing preserves executable mode and rejects binary text", async () => {
    const c = await canvas(),
      a = await agent(c, "write"),
      child = await start(a.id);
    const path = join((await k.host.scope(child.actor)).scratch, "script.sh");
    await writeFile(path, "#!/bin/sh\necho old\n");
    await chmod(path, 0o750);
    expect(
      (await child.call("edit", { path, edits: [{ oldText: "old", newText: "new" }] })).result
        .isError,
    ).not.toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o750);
    expect(
      (await child.call("write", { path, content: "#!/bin/sh\necho again\n" })).result.isError,
    ).not.toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o750);
    const bytes = join((await k.host.scope(child.actor)).scratch, "binary");
    await writeFile(bytes, Buffer.from([0, 1, 2, 3]));
    expect(
      (await child.call("read", { target: { kind: "path", path: bytes } })).result.isError,
    ).toBe(true);
  });
  it("T46 a member's approved path request does not grant a non-admin manager host execution", async () => {
    const c = await canvas(),
      m = await agent(c, "write", false),
      a = await agent(m.id, "write");
    const manager = await start(m.id),
      child = await start(a.id);
    const path = (await k.host.scope(manager.actor)).scratch;
    await writeFile(join(path, "evidence.txt"), "authorized member read");
    const pending = await child.call("request_permission", {
      scope: { kind: "path", path, access: "directory_and_commands" },
      reason: "review parent files",
    });
    expect(
      (await k.access.list(c, { actor: manager.actor })).requests[0]?.allowedActions,
    ).not.toContain("approve");
    await decide(pending.value.requestId);
    expect(
      (await child.call("read", { target: { kind: "path", path: join(path, "evidence.txt") } }))
        .value.text,
    ).toBe("authorized member read");
    expect(await grantsFor(k.db.pool, m.id)).toHaveLength(0);
    expect((await manager.call("bash", { command: "true", fullHost: true })).waiting).toBe(
      "approval",
    );
  });
  it("T45 stopping a run does not disable its Agent mailbox or imply message acknowledgement", async () => {
    const c = await canvas(),
      m = await agent(c, "admin", false),
      a = await agent(m.id, "write");
    await start(m.id);
    const child = await start(a.id);
    await k.conversations.stop(m.id);
    const delivery = await child.call("send_message", {
      target: { kind: "agent", agentId: m.id },
      message: "new work after stop",
    });
    expect(delivery.value.delivered).toBe(1);
    const status = (await child.call("get_agent_status", { agentIds: [m.id] })).value.agents[0];
    expect(status.cancelRequested).toBe(true);
    expect(status.activationMode).toBe("on_demand");
    expect(status.canReceiveMessages).toBe(true);
    const history = await k.conversations.read.history(
      (await k.conversations.read.forAgent(m.id)).id,
    );
    expect(
      history.some((m) => m.role === "message" && m.content.text === "new work after stop"),
    ).toBe(true);
  });
  it("T40 a reviewer can use its manager's workspace and deliver the report without user escalation", async () => {
    const c = await canvas(),
      m = await agent(c, "admin", false),
      a = await agent(m.id, "write");
    const manager = await start(m.id),
      child = await start(a.id);
    const path = (await k.host.scope(manager.actor)).scratch;
    await writeFile(join(path, "evidence.txt"), "manager-owned evidence");
    const pending = await child.call("request_permission", {
      scope: { kind: "path", path, access: "directory_and_commands" },
      reason: "Review assigned files",
    });
    expect(pending.waiting).toBe("approval");
    const page = await k.access.list(c, { actor: manager.actor });
    expect(page.requests[0]?.allowedActions).toContain("approve");
    await decide(pending.value.requestId, manager.actor);
    const resumed = await child.call(
      "request_permission",
      {
        scope: { kind: "path", path, access: "directory_and_commands" },
        reason: "Review assigned files",
      },
      pending.logical,
    );
    expect(resumed.value.status).toBe("granted");
    expect((await k.graph.queries.node(resumed.value.nodeId)).title).toContain(m.title);
    expect(
      (await child.call("read", { target: { kind: "path", path: join(path, "evidence.txt") } }))
        .value.text,
    ).toBe("manager-owned evidence");
    const report = await child.call("create_artifact", {
      kind: "text",
      title: "QA report",
      text: "verified",
      shareWithManagers: true,
    });
    expect(report.value.sharedWith).toEqual([m.id]);
    expect(
      (await manager.call("read", { target: { kind: "node", nodeId: report.value.id } })).value
        .content,
    ).toBe("verified");
    expect(
      (await child.call("report_result", { message: "review delivered" })).value.delivered,
    ).toBe(1);
    expect(
      (
        await child.call("send_message", {
          target: { kind: "agent", agentId: m.id },
          message: "follow up",
        })
      ).value.delivered,
    ).toBe(1);
    const status = (await child.call("get_agent_status", { agentIds: [m.id] })).value.agents[0];
    expect(status.activationMode).toBe("on_demand");
    expect(status.canReceiveMessages).toBe(true);
    const ownerLink = (
      await k.db.pool.query(
        "select source_link_id from grants where subject_id=$1 and resource_id=$2",
        [m.id, resumed.value.nodeId],
      )
    ).rows[0];
    await k.graph.deleteLink(ownerLink.source_link_id, { idempotencyKey: key() });
    expect(
      (await grantsFor(k.db.pool, a.id)).some((g) => g.resource_id === resumed.value.nodeId),
    ).toBe(false);
  });
  it("T41 an unrelated private directory still blocks sharing and reports which managers were skipped", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      a = await agent(m.id, "write");
    const manager = await start(m.id),
      child = await start(a.id);
    const pending = await child.call("request_permission", {
      scope: { kind: "path", path: area, access: "directory_and_commands" },
      reason: "Private evidence",
    });
    expect(
      (await k.access.list(c, { actor: manager.actor })).requests[0]?.allowedActions,
    ).not.toContain("approve");
    await decide(pending.value.requestId);
    const report = await child.call("create_artifact", {
      kind: "text",
      title: "private findings",
      text: "PRIVATE",
      shareWithManagers: true,
    });
    expect(report.value.sharedWith).toEqual([]);
    expect(report.value.sharing.skippedManagers).toEqual([m.id]);
    expect(report.value.sharing.status).toBe("blocked");
    expect((await child.call("report_result", { message: "PRIVATE" })).waiting).toBe("approval");
  });
  it("T42 applicants can inspect an escalated expired request without retrying its action", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      a = await agent(m.id, "read");
    const manager = await start(m.id),
      child = await start(a.id);
    const pending = await child.call("request_permission", {
      scope: { kind: "role", role: "admin" },
      reason: "needs owner",
    });
    await decide(pending.value.requestId, manager.actor, "escalate");
    await k.db.pool.query("update approvals set expires_at=now()-interval '1 second' where id=$1", [
      pending.value.requestId,
    ]);
    await k.access.maintain();
    const history = await child.call("list_access_requests", {
      requestId: pending.value.requestId,
    });
    expect(history.value.requests[0]).toMatchObject({
      status: "expired",
      routeReason: "escalated",
      reviewerId: null,
    });
    expect(history.value.requests[0].decidedAt).toBeTruthy();
    const receipt = await child.call(
      "request_permission",
      { scope: { kind: "role", role: "admin" }, reason: "needs owner" },
      pending.logical,
    );
    expect(receipt.value).toMatchObject({ status: "expired", executed: false, reviewerId: null });
    expect(receipt.value.nextAction).toBeTruthy();
  });
  it("T43 a sibling's workspace and a redirected ancestor workspace do not confer ownership", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      a = await agent(m.id, "write"),
      sibling = await agent(c, "write");
    const manager = await start(m.id),
      child = await start(a.id);
    const siblingPath = await k.host.workspace(c, sibling.id);
    const siblingRequest = await child.call("request_permission", {
      scope: { kind: "path", path: siblingPath, access: "directory_and_commands" },
      reason: "not owned by manager",
    });
    expect((await request(siblingRequest.value.requestId)).action.workspaceOwnerId).toBeUndefined();
    expect(
      (
        await k.access.list(c, {
          actor: manager.actor,
          requestIds: [siblingRequest.value.requestId],
        })
      ).requests[0]?.allowedActions,
    ).not.toContain("approve");
    const redirect = join((await k.host.scope(manager.actor)).scratch, "redirect");
    await symlink(area, redirect);
    const escaped = await child.call("request_permission", {
      scope: { kind: "path", path: redirect, access: "directory_and_commands" },
      reason: "external symlink",
    });
    expect((await request(escaped.value.requestId)).action.workspaceOwnerId).toBeUndefined();
    const forged = await child.call("request_permission", {
      scope: { kind: "path", path: area, access: "directory_and_commands" },
      reason: "forged",
      workspaceOwnerId: m.id,
    });
    expect(forged.result.isError).toBe(true);
  });
  it("T44 image reads deliver image content and reject binary text, invalid frames and unapproved paths", async () => {
    const c = await canvas(),
      a = await agent(c, "read"),
      child = await start(a.id);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQMgkTMgljgFAAEA4CcV2GZ44AAAAASUVORK5CYII=",
      "base64",
    );
    const path = join((await k.host.scope(child.actor)).scratch, "pixel.png");
    await writeFile(path, png);
    expect(
      (await child.call("read", { target: { kind: "path", path }, mode: "text" })).result.isError,
    ).toBe(true);
    const automaticImage = await child.call("read", { target: { kind: "path", path } });
    expect(automaticImage.result.isError).not.toBe(true);
    expect(automaticImage.result.content.some((p) => p.type === "image")).toBe(true);
    const image = await child.call("read", { target: { kind: "path", path } });
    expect(image.result.content.some((p) => p.type === "image" && p.mimeType === "image/png")).toBe(
      true,
    );
    expect(
      (await child.call("read", { target: { kind: "path", path }, frame: 1 })).result.isError,
    ).toBe(true);
    const gifPath = join((await k.host.scope(child.actor)).scratch, "two-frames.gif");
    await writeFile(
      gifPath,
      Buffer.from(
        "R0lGODlhAQABAIAAAExpcf8AACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFCgAAACwAAAAAAQABAAACAkwBACH5BAUKAAAALAAAAAABAAEAgExpcQD/AAICTAEAOw==",
        "base64",
      ),
    );
    const frame0 = await child.call("read", { target: { kind: "path", path: gifPath }, frame: 0 });
    const frame1 = await child.call("read", { target: { kind: "path", path: gifPath }, frame: 1 });
    expect(frame1.value.frames).toBe(2);
    expect(frame0.result.content[1]).not.toEqual(frame1.result.content[1]);
    expect(
      (await child.call("read", { target: { kind: "path", path: gifPath }, frame: 2 })).result
        .isError,
    ).toBe(true);
    const privatePath = join(area, `${key()}.png`);
    await writeFile(privatePath, png);
    const pending = await child.call("read", { target: { kind: "path", path: privatePath } });
    expect(pending.waiting).toBe("approval");
    await decide(pending.value.requestId);
    expect(
      (
        await child.call("read", { target: { kind: "path", path: privatePath } }, pending.logical)
      ).result.content.some((p) => p.type === "image"),
    ).toBe(true);
    const textOnlyTools = await k.tools.create(
      { run: child.run, store: k.runs, signal: new AbortController().signal, progress() {} },
      {
        ...child.run.frozen_input,
        model: { config: { kind: "mock", streamDelayMs: 0, supportsVision: false } },
      },
    );
    expect(textOnlyTools.find((t) => t.name === "read")?.modelVisible).not.toBe(false);
  });
  it("T34 publishing a scratch artifact preserves the complete team coordination journey", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      a = await agent(m.id, "write"),
      b = await agent(m.id, "write");
    const manager = await start(m.id),
      author = await start(a.id),
      peer = await start(b.id);
    const path = join((await k.host.scope(author.actor)).scratch, "delivery.md");
    await writeFile(path, "published evidence");
    const report = await author.call("create_artifact", {
      kind: "text",
      title: "delivery",
      text: "evidence",
      path,
    });
    expect(report.result.isError).not.toBe(true);
    expect(
      (await manager.call("read", { target: { kind: "node", nodeId: report.value.id } })).waiting,
    ).toBeUndefined();
    expect(
      (await grantsFor(k.db.pool, m.id)).find((g) => g.resource_id === report.value.id)?.mode,
    ).toBe("read");
    for (const [from, to] of [
      [manager, author],
      [author, manager],
      [peer, author],
      [author, peer],
    ])
      expect(
        (
          await from!.call("send_message", {
            target: { kind: "agent", agentId: to!.actor.agentId },
            message: "follow up",
          })
        ).waiting,
      ).toBeUndefined();
    expect((await author.call("report_result", { message: "delivered" })).waiting).toBeUndefined();
    const command = await author.call("bash", { command: "printf reviewed", fullHost: true });
    expect(command.waiting).toBe("approval");
    await decide(command.value.requestId, manager.actor);
    expect(
      (await author.call("bash", { command: "printf reviewed", fullHost: true }, command.logical))
        .value.output,
    ).toBe("reviewed");
    expect(
      (await grantsFor(k.db.pool, m.id)).filter((g) => g.resource?.type === "directory"),
    ).toHaveLength(0);
    expect((await grantsFor(k.db.pool, b.id)).some((g) => g.resource_id === report.value.id)).toBe(
      false,
    );
  });
  it("T35 missing attachments and unknown artifact fields fail without creating nodes", async () => {
    const c = await canvas(),
      a = await agent(c, "write"),
      caller = await start(a.id);
    const count = async () =>
      (await k.db.pool.query("select count(*)::int as n from nodes where canvas_id=$1", [c]))
        .rows[0].n;
    const before = await count();
    const missing = await caller.call("create_artifact", {
      kind: "text",
      title: "missing",
      path: "absent.md",
      text: "report",
    });
    expect(missing.result.isError).toBe(true);
    expect(missing.waiting).toBeUndefined();
    const unknown = await caller.call("create_artifact", {
      kind: "text",
      title: "lost body",
      content: "must not be ignored",
    });
    expect(unknown.result.isError).toBe(true);
    expect(String(unknown.value)).toContain("content");
    expect(await count()).toBe(before);
  });
  it("T36 an unauthorized reviewer sees safe routing and can send an explicit denial message", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      a = await agent(m.id, "write"),
      privateNode = await resource(c);
    await connect(a.id, privateNode.id);
    const manager = await start(m.id),
      child = await start(a.id);
    const pending = await child.call("send_message", {
      target: { kind: "agent", agentId: m.id },
      message: "PRIVATE-BODY",
    });
    const page = await k.access.list(c, { actor: manager.actor });
    expect(page.requests[0]?.summary.recipients).toEqual([m.id]);
    expect(page.requests[0]?.names?.[m.id]).toBe(m.title);
    expect(page.requests[0]?.blockedReason).toBe("outside_authority");
    expect(
      (await k.access.list(c, { actor: child.actor })).requests[0]?.blockedReason,
    ).toBeUndefined();
    expect(JSON.stringify(page)).not.toContain("PRIVATE-BODY");
    const inbox = await k.access.forSubject(c, m.id);
    expect(inbox.some((r) => r.id === pending.value.requestId)).toBe(true);
    await manager.call("review_access_request", {
      requestId: pending.value.requestId,
      version: 1,
      decision: "deny",
      reason: "PRIVATE-AUDIT-NOTE",
      messageToRequester: "Wait for a revised assignment",
    });
    const denied = await child.call(
      "send_message",
      { target: { kind: "agent", agentId: m.id }, message: "PRIVATE-BODY" },
      pending.logical,
    );
    expect(denied.value.message).toBe("Wait for a revised assignment");
    expect(JSON.stringify(denied)).not.toContain("PRIVATE-AUDIT-NOTE");
  });
  it("T37 an imported external file is not implicitly published even by an admin author", async () => {
    const c = await canvas(),
      m = await agent(c, "read"),
      a = await agent(m.id, "admin"),
      child = await start(a.id);
    const path = join(area, key());
    await writeFile(path, "external private evidence");
    const attachment = await child.call("create_artifact", {
      kind: "text",
      title: "external",
      path,
    });
    expect(attachment.result.isError).not.toBe(true);
    expect(attachment.value.sharedWith).toEqual([]);
    expect(
      (await grantsFor(k.db.pool, m.id)).some((g) => g.resource_id === attachment.value.id),
    ).toBe(false);
  });
  it("T38 host read pagination continues across long lines without losing text", async () => {
    const c = await canvas(),
      a = await agent(c, "write"),
      child = await start(a.id);
    const path = join((await k.host.scope(child.actor)).scratch, "long.txt");
    const text = `${'"\\汉'.repeat(20000)}\n${"a line\n".repeat(477)}`;
    await writeFile(path, text);
    let cursor: string | null = null,
      reconstructed = "",
      pages = 0;
    do {
      const read = await child.call("read", {
        target: { kind: "path", path },
        ...(cursor ? { cursor } : {}),
      });
      expect(read.result.isError).not.toBe(true);
      reconstructed += read.value.text;
      cursor = read.value.nextCursor;
      pages++;
      expect(read.value.truncated).toBe(cursor !== null);
    } while (cursor !== null && pages < 10);
    expect(cursor).toBeNull();
    expect(pages).toBeGreaterThan(2);
    expect(reconstructed).toBe(text);
  });
  it("T39 cosmetic report renames do not reactivate a subscribed team, content changes do", async () => {
    const c = await canvas(),
      a = await agent(c, "write"),
      r = await resource(c);
    await connect(a.id, r.id);
    const pending = async () =>
      (
        await k.db.pool.query(
          "select count(*)::int as n from schedules where agent_id=$1 and kind='resource_change' and enabled",
          [a.id],
        )
      ).rows[0].n;
    const renamed = await k.graph.updateNode(r.id, {
      title: "Historical report",
      expectedRevision: r.revision,
      idempotencyKey: key(),
    });
    expect(await pending()).toBe(0);
    await k.graph.updateNode(r.id, {
      text: "new evidence",
      expectedRevision: renamed.node.revision,
      idempotencyKey: key(),
    });
    expect(await pending()).toBe(1);
  });
  it("T23 differently scoped teammates can exchange messages and broadcasts without acquiring each other's resources", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      a = await agent(m.id, "write"),
      b = await agent(m.id, "write"),
      left = await resource(c),
      right = await resource(c);
    await connect(m.id, left.id);
    await connect(m.id, right.id);
    await connect(a.id, left.id);
    await connect(b.id, right.id);
    const members = [await start(m.id), await start(a.id), await start(b.id)];
    for (const from of members)
      for (const to of members)
        if (from !== to) {
          const sent = await from.call("send_message", {
            target: { kind: "agent", agentId: to.actor.agentId },
            message: "team coordination",
          });
          expect(sent.waiting).toBeUndefined();
          expect(sent.value.delivered).toBe(1);
        }
    const broadcast = await members[1]!.call("send_message", {
      target: { kind: "resource_readers", resourceIds: [left.id] },
      message: "shared evidence",
    });
    expect(broadcast.waiting).toBeUndefined();
    expect(broadcast.value.delivered).toBe(1);
    expect((await grantsFor(k.db.pool, a.id)).map((g) => g.resource_id)).not.toContain(right.id);
    expect((await k.access.list(c, { status: "pending" })).total).toBe(0);
  });
  it("T24 new team artifacts reach authorized managers atomically and survive employee departure", async () => {
    const c = await canvas(),
      top = await agent(c, "admin"),
      m = await agent(top.id, "admin"),
      b = await agent(m.id, "write"),
      r = await resource(c);
    for (const a of [top, m, b]) await connect(a.id, r.id);
    const director = await start(top.id),
      manager = await start(m.id),
      child = await start(b.id);
    const artifact = await child.call("create_artifact", {
      kind: "text",
      title: "findings",
      text: "verified evidence",
    });
    for (const a of [director, manager]) {
      const read = await a.call("read", { target: { kind: "node", nodeId: artifact.value.id } });
      expect(read.waiting).toBeUndefined();
      expect(read.value.content).toBe("verified evidence");
    }
    expect(
      (await child.call("report_result", { message: "findings saved" })).waiting,
    ).toBeUndefined();
    const links = (
      await k.db.pool.query("select * from edges where kind='user_link' and to_id=$1", [
        artifact.value.id,
      ])
    ).rows;
    expect(links.map((e) => e.from_id).sort()).toEqual([top.id, m.id].sort());
    const dismissed = await manager.call("dismiss_agent", { agentId: b.id });
    expect(dismissed.waiting).toBeUndefined();
    expect(dismissed.result.isError).not.toBe(true);
    expect(
      (await manager.call("read", { target: { kind: "node", nodeId: artifact.value.id } })).value
        .content,
    ).toBe("verified evidence");
  });
  it("T25 private member resources neither publish new artifacts nor authorize team messages", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      b = await agent(m.id, "write"),
      privateNode = await resource(c);
    await connect(b.id, privateNode.id);
    const child = await start(b.id);
    const artifact = await child.call("create_artifact", {
      kind: "text",
      title: "private",
      text: "private evidence",
    });
    expect((await grantsFor(k.db.pool, m.id)).map((g) => g.resource_id)).not.toContain(
      artifact.value.id,
    );
    expect(
      (
        await child.call("send_message", {
          target: { kind: "agent", agentId: m.id },
          message: "private evidence",
        })
      ).waiting,
    ).toBe("approval");
  });
  it("T26 managers configure narrower members without resource equality or mixed-field role escalation", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      b = await agent(m.id, "write"),
      extra = await resource(c);
    await connect(m.id, extra.id);
    const manager = await start(m.id);
    const configured = await manager.call("configure_agent", {
      agentId: b.id,
      expectedRevision: b.revision,
      patch: { persona: "updated task", respondToResources: true },
    });
    expect(configured.waiting).toBeUndefined();
    expect(configured.result.isError).not.toBe(true);
    const current = await k.graph.queries.node(b.id);
    expect(current.agent!.persona).toBe("updated task");
    expect(
      (
        await manager.call("configure_agent", {
          agentId: b.id,
          expectedRevision: current.revision,
          patch: { persona: "privileged", role: "admin" },
        })
      ).waiting,
    ).toBe("approval");
  });
  it("T27 todo item indices ignore prose and code fences and invalid indices remain recoverable", async () => {
    const c = await canvas(),
      a = await agent(c, "write"),
      caller = await start(a.id);
    const text = "Introduction\n\n```md\n- [ ] example only\n```\n- [ ] first\n\n1. [ ] second";
    const todo = await caller.call("create_artifact", { kind: "todo", title: "plan", text });
    const first = await caller.call("update_node", {
      nodeId: todo.value.id,
      expectedRevision: 1,
      patch: { kind: "todo_item", itemIndex: 0, completed: true },
    });
    expect(first.waiting).toBeUndefined();
    expect(first.result.isError).not.toBe(true);
    const n = await k.graph.queries.node(todo.value.id);
    expect(n.text).toContain("- [x] first");
    expect(n.text).toContain("- [ ] example only");
    const invalid = await caller.call("update_node", {
      nodeId: n.id,
      expectedRevision: n.revision,
      patch: { kind: "todo_item", itemIndex: 99, completed: true },
    });
    expect(invalid.waiting).toBeUndefined();
    expect(invalid.result.isError).toBe(true);
    expect(invalid.value).toMatch(/index|序号/i);
    expect((await k.graph.queries.node(n.id)).revision).toBe(n.revision);
    const second = await caller.call("update_node", {
      nodeId: n.id,
      expectedRevision: n.revision,
      patch: { kind: "todo_item", itemIndex: 1, completed: true },
    });
    expect(second.result.isError).not.toBe(true);
    expect((await k.graph.queries.node(n.id)).text).toContain("1. [x] second");
  });
  it("T28 nested directory grants preserve the explicit working root and multi-root host capability", async () => {
    const nestedPath = join(area, key());
    await mkdir(nestedPath);
    const c = await canvas(),
      m = await agent(c, "admin"),
      root = await resource(c, area),
      nested = await resource(root.id, nestedPath);
    await connect(m.id, root.id);
    const manager = await start(m.id);
    await manager.call("request_permission", {
      scope: { kind: "path", path: area, access: "directory", mode: "write", execution: "host" },
      reason: "Explicit host execution for this team",
    });
    const hired = await manager.call("hire_agent", {
      title: "worker",
      persona: "",
      task: "inspect",
      role: "write",
      respondToResources: false,
      resourceIds: [root.id],
    });
    const child = await start(hired.value.id);
    const first = await child.call("bash", { command: "pwd", fullHost: true });
    expect(first.waiting).toBeUndefined();
    expect(first.value.output.trim()).toBe(area);
    await connect(hired.value.id, nested.id);
    const second = await child.call("bash", { command: "pwd", fullHost: true });
    expect(second.waiting).toBeUndefined();
    expect(second.value.exitCode).toBe(0);
  });
  it("T29 managers can approve a one-off host command in a member workspace without granting resources", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      b = await agent(m.id, "write"),
      manager = await start(m.id),
      child = await start(b.id);
    const args = { command: "printf approved", fullHost: true };
    const pending = await child.call("bash", args);
    expect(pending.waiting).toBe("approval");
    await decide(pending.value.requestId, manager.actor);
    const done = await child.call("bash", args, pending.logical);
    expect(done.result.isError).not.toBe(true);
    expect(done.value.output).toBe("approved");
    expect(await grantsFor(k.db.pool, b.id)).toHaveLength(0);
  });
  it("T30 delivery respects read-only managers and does not expose private file attachments", async () => {
    const c = await canvas(),
      m = await agent(c, "read"),
      b = await agent(m.id, "write");
    const child = await start(b.id);
    const report = await child.call("create_artifact", {
      kind: "text",
      title: "public result",
      text: "result",
    });
    expect(
      (await grantsFor(k.db.pool, m.id)).find((g) => g.resource_id === report.value.id)?.mode,
    ).toBe("read");
    const path = join((await k.host.scope(child.actor)).scratch, "private-attachment.txt");
    await writeFile(path, "private file");
    const attachment = await child.call("create_artifact", {
      kind: "text",
      title: "attachment",
      path,
      shareWithManagers: false,
    });
    expect(attachment.result.isError).not.toBe(true);
    expect((await grantsFor(k.db.pool, m.id)).map((g) => g.resource_id)).not.toContain(
      attachment.value.id,
    );
    expect((await grantsFor(k.db.pool, b.id)).map((g) => g.resource_id)).toContain(
      attachment.value.id,
    );
  });
  it("T31 output grants are revocable and undoable without granting past delivery to a new manager", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      next = await agent(c, "admin"),
      b = await agent(m.id, "write");
    const child = await start(b.id);
    const report = await child.call("create_artifact", {
      kind: "text",
      title: "delivered",
      text: "original team",
    });
    await k.graph.submitMove({
      targetParentId: next.id,
      moves: [{ nodeId: b.id, x: 10, y: 10 }],
      idempotencyKey: key(),
    });
    expect((await grantsFor(k.db.pool, next.id)).map((g) => g.resource_id)).not.toContain(
      report.value.id,
    );
    expect((await grantsFor(k.db.pool, m.id)).map((g) => g.resource_id)).toContain(report.value.id);
    const edge = (
      await k.db.pool.query(
        "select id from edges where from_id=$1 and to_id=$2 and kind='user_link'",
        [m.id, report.value.id],
      )
    ).rows[0];
    const removal = await k.graph.deleteLink(edge.id, { idempotencyKey: key() });
    expect((await grantsFor(k.db.pool, m.id)).map((g) => g.resource_id)).not.toContain(
      report.value.id,
    );
    expect((await grantsFor(k.db.pool, b.id)).map((g) => g.resource_id)).toContain(report.value.id);
    await k.graph.undoGraphOp(removal.graphOpId);
    expect((await grantsFor(k.db.pool, m.id)).map((g) => g.resource_id)).toContain(report.value.id);
    expect((await grantsFor(k.db.pool, next.id)).map((g) => g.resource_id)).not.toContain(
      report.value.id,
    );
  });
  it("T32 mixed-field configuration cannot activate write grants beyond manager authority", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      b = await agent(m.id, "read"),
      r = await resource(c);
    await connect(m.id, r.id);
    await connect(b.id, r.id);
    await k.db.pool.query("update grants set mode='read' where subject_id=$1", [m.id]);
    const manager = await start(m.id);
    const change = await manager.call("configure_agent", {
      agentId: b.id,
      expectedRevision: b.revision,
      patch: { persona: "write requested", role: "write", respondToResources: true },
    });
    expect(change.waiting).toBe("approval");
    expect((await k.graph.queries.node(b.id)).agent!.role).toBe("read");
  });
  it("T33 delivering an attachment cannot upgrade a manager's read-only path authority", async () => {
    const c = await canvas(),
      m = await agent(c, "write"),
      b = await agent(m.id, "write"),
      root = await resource(c, area);
    await connect(m.id, root.id);
    await connect(b.id, root.id);
    await k.db.pool.query("update grants set mode='read' where subject_id=$1", [m.id]);
    const child = await start(b.id),
      path = join(area, key());
    await writeFile(path, "original file");
    const attachment = await child.call("create_artifact", {
      kind: "text",
      title: "file report",
      path,
    });
    expect(attachment.result.isError).not.toBe(true);
    expect(
      (await grantsFor(k.db.pool, m.id)).find((g) => g.resource_id === attachment.value.id)?.mode,
    ).toBe("read");
    const manager = await start(m.id);
    expect(
      (await manager.call("read", { target: { kind: "path", path } })).waiting,
    ).toBeUndefined();
    expect((await manager.call("write", { path, content: "must not overwrite" })).waiting).toBe(
      "approval",
    );
    expect(await readFile(path, "utf8")).toBe("original file");
  });
  it("T01 container grants cover nested resources but stop at Agent boundaries", async () => {
    const c = await canvas(),
      a = await agent(c, "write"),
      root = await resource(c);
    const nested = await resource(root.id),
      leaf = await resource(nested.id);
    const boundary = await agent(root.id),
      privateNode = await resource(boundary.id);
    await connect(a.id, root.id);
    const caller = await start(a.id);
    expect(
      (await caller.call("read", { target: { kind: "node", nodeId: leaf.id } })).waiting,
    ).toBeUndefined();
    expect(
      (
        await caller.call("update_node", {
          nodeId: leaf.id,
          expectedRevision: leaf.revision,
          patch: { kind: "content", text: "updated" },
        })
      ).result.isError,
    ).not.toBe(true);
    expect((await k.graph.queries.node(leaf.id)).text).toBe("updated");
    expect((await grantsFor(k.db.pool, a.id)).map((g) => g.resource_id)).not.toContain(
      privateNode.id,
    );
  });
  it("T02 hiring grants selected resources before the first task and revokes delegated access with its source", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      root = await resource(c),
      leaf = await resource(root.id),
      other = await resource(c);
    const link = await connect(m.id, root.id);
    await connect(m.id, other.id);
    const manager = await start(m.id);
    const hired = await manager.call("hire_agent", {
      title: "scoped member",
      persona: "",
      task: "read assigned resource",
      role: "write",
      respondToResources: false,
      resourceIds: [leaf.id],
    });
    expect(hired.result.isError).not.toBe(true);
    expect((await grantsFor(k.db.pool, hired.value.id)).map((g) => g.resource_id)).toContain(
      leaf.id,
    );
    expect((await grantsFor(k.db.pool, hired.value.id)).map((g) => g.resource_id)).not.toContain(
      other.id,
    );
    expect(
      (
        await k.conversations.read.history((await k.conversations.read.forAgent(hired.value.id)).id)
      ).filter((m) => m.role === "message"),
    ).toHaveLength(1);
    await k.graph.deleteLink(link.edge.id, { idempotencyKey: key() });
    expect((await grantsFor(k.db.pool, hired.value.id)).map((g) => g.resource_id)).not.toContain(
      leaf.id,
    );
  });
  it("T03 on-demand managers receive path requests and escalate one management level at a time", async () => {
    const c = await canvas(),
      top = await agent(c, "admin", false),
      middle = await agent(top.id, "admin", false),
      b = await agent(middle.id, "write");
    const r = await resource(c, area);
    await connect(top.id, r.id);
    const child = await start(b.id),
      manager = await start(middle.id),
      director = await start(top.id);
    const pending = await child.call("request_permission", {
      scope: { kind: "path", path: area, access: "directory", mode: "read" },
      reason: "read source",
    });
    expect((await request(pending.value.requestId)).assigned_reviewer_id).toBe(middle.id);
    await expect(decide(pending.value.requestId, manager.actor)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await decide(pending.value.requestId, manager.actor, "escalate");
    expect((await request(pending.value.requestId)).assigned_reviewer_id).toBe(top.id);
    await decide(pending.value.requestId, director.actor);
    expect(
      (await child.call("read", { target: { kind: "path", path: area } })).waiting,
    ).toBeUndefined();
  });
  it("T04 moving resources out of a connected container revokes access and undo restores it", async () => {
    const c = await canvas(),
      a = await agent(c, "write"),
      root = await resource(c),
      leaf = await resource(root.id);
    await connect(a.id, root.id);
    const caller = await start(a.id);
    expect((await grantsFor(k.db.pool, a.id)).map((g) => g.resource_id)).toContain(leaf.id);
    const move = await k.graph.submitMove({
      targetParentId: c,
      moves: [{ nodeId: leaf.id, x: 5, y: 5 }],
      idempotencyKey: key(),
    });
    expect((await grantsFor(k.db.pool, a.id)).map((g) => g.resource_id)).not.toContain(leaf.id);
    expect((await k.runs.get(caller.run.id)).cancel_requested_at).not.toBeNull();
    await k.graph.undoGraphOp(move.graphOpId);
    expect((await grantsFor(k.db.pool, a.id)).map((g) => g.resource_id)).toContain(leaf.id);
  });
  it("T05 a direct report can reach a manager with additional resources", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      b = await agent(m.id, "write"),
      shared = await resource(c),
      extra = await resource(c);
    await connect(m.id, shared.id);
    await connect(b.id, shared.id);
    await connect(m.id, extra.id);
    const child = await start(b.id);
    expect(
      (await child.call("report_result", { message: "blocked on another resource" })).waiting,
    ).toBeUndefined();
    expect(
      (await k.conversations.read.history((await k.conversations.read.forAgent(m.id)).id)).some(
        (m) => m.content.text === "blocked on another resource",
      ),
    ).toBe(true);
  });
  it("T06 inherited container access respects read roles and promotes only within manager scope", async () => {
    const c = await canvas(),
      m = await agent(c, "admin", false),
      root = await resource(c),
      folder = await resource(root.id, area);
    await connect(m.id, root.id);
    const manager = await start(m.id);
    const args = {
      title: "reader",
      persona: "",
      task: "inspect files",
      role: "read",
      respondToResources: false,
      inheritResources: true,
    };
    const hired = await manager.call("hire_agent", args);
    const b = hired.value.id;
    expect((await grantsFor(k.db.pool, b)).find((g) => g.resource_id === folder.id)?.mode).toBe(
      "read",
    );
    const child = await start(b),
      path = join(area, key());
    expect(
      (await child.call("read", { target: { kind: "path", path: area } })).waiting,
    ).toBeUndefined();
    const pending = await child.call("write", { path, content: "after approval" });
    expect(pending.waiting).toBe("approval");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await request(pending.value.requestId)).assigned_reviewer_id).toBe(m.id);
    await decide(pending.value.requestId, manager.actor);
    await child.call("write", { path, content: "after approval" }, pending.logical);
    expect(await readFile(path, "utf8")).toBe("after approval");
  });
  it("T07 recruitment rejects cross-canvas or unavailable resources atomically and replays grants once", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      r = await resource(c),
      foreign = await resource(await canvas());
    await connect(m.id, r.id);
    const manager = await start(m.id);
    const args = {
      title: "member",
      persona: "",
      task: "one task",
      role: "write",
      respondToResources: false,
      resourceIds: [r.id],
    };
    for (const ids of [[foreign.id], [r.id, foreign.id]]) {
      expect((await manager.call("hire_agent", { ...args, resourceIds: ids })).result.isError).toBe(
        true,
      );
      expect((await k.graph.queries.children(m.id)).filter((n) => n.kind === "agent")).toHaveLength(
        0,
      );
    }
    const hired = await manager.call("hire_agent", args);
    expect((await manager.call("hire_agent", args, hired.logical)).value.id).toBe(hired.value.id);
    expect(
      (await k.db.pool.query("select * from grants where subject_id=$1", [hired.value.id])).rows,
    ).toHaveLength(1);
  });
  it("T08 delegation through two managers is revoked on ancestor downgrade", async () => {
    const c = await canvas(),
      top = await agent(c, "admin"),
      mid = await agent(top.id, "admin"),
      b = await agent(mid.id, "write"),
      r = await resource(c);
    await connect(top.id, r.id);
    const director = await start(top.id),
      manager = await start(mid.id),
      child = await start(b.id);
    const first = await manager.call("request_permission", {
      scope: { kind: "resource", nodeId: r.id, mode: "write" },
      reason: "delegate",
    });
    await decide(first.value.requestId, director.actor);
    const second = await child.call("request_permission", {
      scope: { kind: "resource", nodeId: r.id, mode: "read" },
      reason: "inspect",
    });
    await decide(second.value.requestId, manager.actor);
    expect((await grantsFor(k.db.pool, b.id)).map((g) => g.resource_id)).toContain(r.id);
    await k.graph.updateNode(top.id, {
      expectedRevision: top.revision,
      agent: { ...top.agent!, role: "read" },
      idempotencyKey: key(),
    });
    expect(await grantsFor(k.db.pool, b.id)).toHaveLength(0);
    expect((await k.runs.get(child.run.id)).cancel_requested_at).not.toBeNull();
  });
  it("T09 independent owner access survives removal of an overlapping delegated grant and undo", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      root = await resource(c),
      leaf = await resource(root.id);
    const edge = await connect(m.id, root.id),
      manager = await start(m.id);
    const hired = await manager.call("hire_agent", {
      title: "member",
      persona: "",
      task: "inspect",
      role: "write",
      respondToResources: false,
      resourceIds: [leaf.id],
    });
    await connect(hired.value.id, leaf.id);
    const child = await start(hired.value.id);
    const removal = await k.graph.deleteLink(edge.edge.id, { idempotencyKey: key() });
    expect((await grantsFor(k.db.pool, hired.value.id)).map((g) => g.resource_id)).toContain(
      leaf.id,
    );
    expect((await k.runs.get(child.run.id)).cancel_requested_at).toBeNull();
    await k.graph.undoGraphOp(removal.graphOpId);
    expect(
      (await grantsFor(k.db.pool, hired.value.id)).filter((g) => g.resource_id === leaf.id),
    ).toHaveLength(2);
  });
  it("T10 on-demand review is scheduled and the owner can decide before the manager", async () => {
    const c = await canvas(),
      m = await agent(c, "read", false),
      b = await agent(m.id, "write"),
      child = await start(b.id);
    const pending = await child.call("request_permission", {
      scope: { kind: "path", path: area, access: "directory_and_commands" },
      reason: "outside manager scope",
    });
    await k.runs.finish(child.run, "waiting", undefined, "approval");
    await k.access.maintain();
    const review = await k.conversations.activeRun((await k.conversations.read.forAgent(m.id)).id);
    expect(review).toBeTruthy();
    expect((await k.runs.get(review!)).state).toBe("queued");
    const reviewer = await start(m.id);
    const requests = await k.access.list(c, { actor: reviewer.actor });
    expect(requests.requests[0]?.allowedActions).toEqual(["deny", "escalate"]);
    const version = (await request(pending.value.requestId)).version;
    await decide(pending.value.requestId);
    await expect(
      k.access.decide(pending.value.requestId, version, "deny", "too late", reviewer.actor),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect((await k.runs.get(child.run.id)).state).toBe("queued");
  });
  it("T11 moving a delegated member to another manager revokes its inherited resource", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      other = await agent(c, "admin"),
      r = await resource(c);
    await connect(m.id, r.id);
    const manager = await start(m.id),
      hired = await manager.call("hire_agent", {
        title: "member",
        persona: "",
        task: "inspect",
        role: "write",
        respondToResources: false,
        inheritResources: true,
      });
    const child = await start(hired.value.id);
    const moved = await k.graph.submitMove({
      targetParentId: other.id,
      moves: [{ nodeId: hired.value.id, x: 0, y: 0 }],
      idempotencyKey: key(),
    });
    expect(await grantsFor(k.db.pool, hired.value.id)).toHaveLength(0);
    expect((await k.runs.get(child.run.id)).cancel_requested_at).not.toBeNull();
    await k.graph.undoGraphOp(moved.graphOpId);
    expect((await grantsFor(k.db.pool, hired.value.id)).map((g) => g.resource_id)).toContain(r.id);
  });
  it("T12 nested resource changes trigger authorized agents without materializing descendant grants", async () => {
    const c = await canvas(),
      a = await agent(c, "write"),
      root = await resource(c);
    await connect(a.id, root.id);
    const nested = await resource(root.id),
      leaf = await resource(nested.id);
    expect((await grantsFor(k.db.pool, a.id)).map((g) => g.resource_id)).toContain(leaf.id);
    expect(
      (await k.db.pool.query("select * from grants where subject_id=$1", [a.id])).rows,
    ).toHaveLength(1);
    expect(
      (
        await k.db.pool.query(
          "select * from schedules where agent_id=$1 and kind='resource_change' and enabled",
          [a.id],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("T13 physical path authorization rejects symlink escapes and sibling-prefix paths", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      b = await agent(m.id, "write");
    const folder = await mkdtemp(join(area, "root-")),
      sibling = `${folder}-sibling`;
    const secret = join(area, key());
    await writeFile(secret, "private");
    await symlink(secret, join(folder, "escape"));
    const r = await resource(c, folder);
    await connect(m.id, r.id);
    await connect(b.id, r.id);
    const child = await start(b.id),
      manager = await start(m.id);
    const pending = await child.call("read", {
      target: { kind: "path", path: join(folder, "escape") },
    });
    expect(pending.waiting).toBe("approval");
    await expect(decide(pending.value.requestId, manager.actor)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const outside = await child.call("write", { path: sibling, content: "must not write" });
    expect(outside.waiting).toBe("approval");
    await expect(readFile(sibling)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("T14 review timeout advances one level and user takeover prevents routing back", async () => {
    const c = await canvas(),
      top = await agent(c, "admin", false),
      mid = await agent(top.id, "read", false),
      b = await agent(mid.id),
      child = await start(b.id);
    const pending = await child.call("request_permission", {
      scope: { kind: "role", role: "admin" },
      reason: "owner only",
    });
    await k.db.pool.query(
      "update approvals set review_due_at=now()-interval '1 second' where id=$1",
      [pending.value.requestId],
    );
    await k.access.maintain();
    expect((await request(pending.value.requestId)).assigned_reviewer_id).toBe(top.id);
    await decide(pending.value.requestId, undefined, "escalate");
    await k.access.maintain();
    expect((await request(pending.value.requestId)).assigned_reviewer_id).toBeNull();
    await decide(pending.value.requestId);
    expect((await k.graph.queries.node(b.id)).agent!.role).toBe("admin");
  });
  it("T15 artifacts avoid existing nodes and keep output-to-source attempt provenance", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      existing = await resource(c),
      manager = await start(m.id);
    await k.graph.submitMove({
      targetParentId: c,
      moves: [{ nodeId: existing.id, x: 104, y: 431 }],
      idempotencyKey: key(),
    });
    const out = await manager.call("create_artifact", {
      kind: "text",
      title: "partial findings",
      text: "Evidence missing; task unfinished",
    });
    expect(out.result.isError).not.toBe(true);
    const node = await k.graph.queries.node(out.value.id),
      a = node.position,
      b = (await k.graph.queries.node(existing.id)).position;
    expect(
      a.x + a.width <= b.x ||
        b.x + b.width <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y,
    ).toBe(true);
    const edge = (
      await k.db.pool.query(
        "select * from edges where from_id=$1 and to_id=$2 and kind='derived_from'",
        [node.id, m.id],
      )
    ).rows[0];
    expect(edge.source_attempt_id).toBe(manager.run.attemptId);
    expect((await grantsFor(k.db.pool, m.id)).map((g) => g.resource_id)).toContain(node.id);
  });
  it("T17 explicitly connected Agent nodes never grant their private descendants", async () => {
    const c = await canvas(),
      a = await agent(c, "write"),
      other = await agent(c),
      hidden = await resource(other.id);
    await connect(a.id, other.id);
    expect((await grantsFor(k.db.pool, a.id)).map((g) => g.resource_id)).toContain(other.id);
    expect((await grantsFor(k.db.pool, a.id)).map((g) => g.resource_id)).not.toContain(hidden.id);
  });
  it("T18 a manager cannot approve recruitment that forwards resources it cannot access", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      b = await agent(m.id, "write"),
      privateNode = await resource(c);
    await connect(b.id, privateNode.id);
    const manager = await start(m.id),
      child = await start(b.id);
    const args = {
      title: "grandchild",
      persona: "",
      task: "inspect private resource",
      role: "read",
      respondToResources: false,
      inheritResources: true,
    };
    const pending = await child.call("hire_agent", args);
    expect(pending.waiting).toBe("approval");
    await expect(decide(pending.value.requestId, manager.actor)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await decide(pending.value.requestId);
    const hired = await child.call("hire_agent", args, pending.logical);
    expect((await grantsFor(k.db.pool, hired.value.id)).map((g) => g.resource_id)).toContain(
      privateNode.id,
    );
  });
  it("T19 routing does not disclose private action payloads to an unauthorized reviewer", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      b = await agent(m.id, "write"),
      folder = await resource(c, area),
      privateNode = await resource(c);
    await connect(m.id, folder.id);
    await connect(b.id, privateNode.id);
    const manager = await start(m.id),
      child = await start(b.id);
    const pending = await child.call("write", {
      path: join(area, key()),
      content: "PRIVATE-PAYLOAD",
    });
    const page = await k.access.list(c, { actor: manager.actor });
    expect(page.requests[0]?.allowedActions).toEqual(["deny", "escalate"]);
    expect(JSON.stringify(page)).not.toContain("PRIVATE-PAYLOAD");
    expect(JSON.stringify(await k.access.list(c))).toContain("PRIVATE-PAYLOAD");
    await decide(pending.value.requestId, manager.actor, "escalate");
    expect((await request(pending.value.requestId)).assigned_reviewer_id).toBeNull();
  });
  it("T20 manager revocation between approval and host execution cannot consume the stale permit", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      b = await agent(m.id, "write"),
      r = await resource(c, area);
    const edge = await connect(m.id, r.id),
      manager = await start(m.id),
      child = await start(b.id);
    const path = join(area, key()),
      args = { path, content: "must stay unwritten" };
    const pending = await child.call("write", args);
    await decide(pending.value.requestId, manager.actor);
    await k.graph.deleteLink(edge.edge.id, { idempotencyKey: key() });
    const resumed = await child.call("write", args, pending.logical);
    expect(resumed.waiting).toBe("approval");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(resumed.value.requestId).not.toBe(pending.value.requestId);
  });
  it("T21 path-covered containers cannot delegate unrelated spatial descendants", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      b = await agent(m.id, "write"),
      owned = await resource(c, area),
      subdirectory = await mkdtemp(join(area, "nested-")),
      target = await resource(c, subdirectory),
      privateNode = await resource(target.id, dir);
    await connect(m.id, owned.id);
    const manager = await start(m.id),
      child = await start(b.id);
    const pending = await child.call("request_permission", {
      scope: { kind: "path", path: subdirectory, access: "directory", mode: "read" },
      reason: "read the physical subdirectory",
    });
    await decide(pending.value.requestId, manager.actor);
    const effective = await grantsFor(k.db.pool, b.id);
    expect(effective.map((g) => g.resource_id)).toContain(target.id);
    expect(effective.map((g) => g.resource_id)).not.toContain(privateNode.id);
    const permissions = async () =>
      app.inject({
        method: "GET",
        url: `/api/v2/canvas-agents/${b.id}/permissions`,
        headers: { authorization: `Bearer ${token}` },
      });
    expect(
      (await app.inject({ method: "GET", url: `/api/v2/canvas-agents/${b.id}/permissions` }))
        .statusCode,
    ).toBe(401);
    const described = (await permissions()).json();
    expect(described.resources.map((r: any) => r.nodeId)).toContain(target.id);
    expect(described.resources.map((r: any) => r.nodeId)).not.toContain(privateNode.id);
    expect(described.resources.every((r: any) => r.sourceLinkId && r.rootId)).toBe(true);
    expect(
      (await child.call("read", { target: { kind: "node", nodeId: privateNode.id } })).waiting,
    ).toBe("approval");
    const explicit = await connect(m.id, target.id);
    expect((await grantsFor(k.db.pool, b.id)).map((g) => g.resource_id)).toContain(privateNode.id);
    await k.graph.deleteLink(explicit.edge.id, { idempotencyKey: key() });
    expect((await grantsFor(k.db.pool, b.id)).map((g) => g.resource_id)).not.toContain(
      privateNode.id,
    );
    expect((await k.runs.get(child.run.id)).cancel_requested_at).not.toBeNull();
    expect((await permissions()).json().resources.map((r: any) => r.nodeId)).not.toContain(
      privateNode.id,
    );
  });
  it("T22 failed pipeline stages do not become successful command evidence", async () => {
    const c = await canvas(),
      a = await agent(c, "admin"),
      caller = await start(a.id);
    const command = await caller.call("bash", {
      command: "false | true",
      cwd: area,
      fullHost: true,
    });
    expect(command.waiting).toBeUndefined();
    expect(command.value.exitCode).toBe(1);
  });
  it("routes implicit file promotions to the direct manager, sends safe notices and resumes the original write", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      b = await agent(m.id),
      r = await resource(c, area);
    await connect(m.id, r.id);
    await connect(b.id, r.id);
    const child = await start(b.id),
      manager = await start(m.id);
    const file = join(area, key());
    const args = { path: file, content: "approved write" };
    const pending = await child.call("write", args);
    expect(pending.waiting).toBe("approval");
    const approval = await request(pending.value.requestId);
    expect(approval.assigned_reviewer_id).toBe(m.id);
    expect(
      (await k.db.pool.query("select state from tool_calls where id=$1", [approval.origin_call_id]))
        .rows[0].state,
    ).toBe("waiting");
    const inbox = await k.conversations.read.history(
      (await k.conversations.read.forAgent(m.id)).id,
    );
    expect(inbox.filter((x) => x.role === "permission_notice")).toHaveLength(1);
    expect(JSON.stringify(inbox)).not.toContain(file);
    await decide(approval.id, manager.actor);
    const done = await child.call("write", args, pending.logical);
    expect(done.result.isError).not.toBe(true);
    expect(await readFile(file, "utf8")).toBe("approved write");
    expect((await k.graph.queries.node(b.id)).agent!.role).toBe("write");
    expect((await request(approval.id)).status).toBe("approved");
  });
  it("completes explicit requests and disallows admin grants through all three Agent tool paths", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      b = await agent(m.id);
    const child = await start(b.id),
      manager = await start(m.id);
    const role = await child.call("request_permission", {
      scope: { kind: "role", role: "admin" },
      reason: "do not forward this instruction",
    });
    expect((await request(role.value.requestId)).assigned_reviewer_id).toBe(m.id);
    await expect(decide(role.value.requestId, manager.actor)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const config = await manager.call("configure_agent", {
      agentId: b.id,
      expectedRevision: b.revision,
      patch: { role: "admin" },
    });
    const hire = await manager.call("hire_agent", {
      title: "privileged",
      task: "Review assigned work",
      persona: "",
      role: "admin",
      respondToResources: true,
    });
    expect(config.waiting).toBe("approval");
    expect(hire.waiting).toBe("approval");
    await expect(decide(hire.value.requestId, manager.actor)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await decide(role.value.requestId);
    const replay = await child.call(
      "request_permission",
      { scope: { kind: "role", role: "admin" }, reason: "do not forward this instruction" },
      role.logical,
    );
    expect(replay.value.status).toBe("granted");
    expect((await k.access.list(c, { subjectId: b.id, status: "pending" })).total).toBe(0);
    await decide(hire.value.requestId);
    const repeated = await manager.call(
      "hire_agent",
      {
        title: "privileged",
        task: "Review assigned work",
        persona: "",
        role: "admin",
        respondToResources: true,
      },
      hire.logical,
    );
    expect((await k.graph.queries.node(repeated.value.id)).agent!.role).toBe("admin");
    expect(
      (
        await k.db.pool.query(
          "select 1 from schedules where agent_id=$1 and kind='resource_change' and enabled",
          [m.id],
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await k.db.pool.query(
          "select count(*)::int as n from nodes where canvas_id=$1 and body->>'title'='privileged'",
          [c],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("keeps a full host approval bound to frozen arguments and one call, including a required role promotion", async () => {
    const c = await canvas(),
      b = await agent(c);
    const child = await start(b.id);
    const file = join(area, key()),
      args = { path: file, content: "one write" };
    const pending = await child.call("write", args);
    const r = await request(pending.value.requestId);
    expect(r.action.requiredRole).toBe("write");
    expect(r.assigned_reviewer_id).toBeNull();
    await decide(r.id);
    expect((await child.call("write", args, pending.logical)).result.isError).not.toBe(true);
    expect(await readFile(file, "utf8")).toBe("one write");
    expect((await child.call("write", args)).waiting).toBe("approval");
    const reading = await child.call("read", { target: { kind: "path", path: file } });
    await decide(reading.value.requestId);
    await child.call("read", { target: { kind: "path", path: file } }, reading.logical);
    await k.db.pool.query(
      "update tool_calls set state='dispatching',result=null where run_id=$1 and logical_call_id=$2",
      [child.run.id, reading.logical],
    );
    expect(
      (await child.call("read", { target: { kind: "path", path: file } }, reading.logical)).value
        .text,
    ).toContain("one write");
    await expect(
      child.call("write", { ...args, content: "changed" }, pending.logical),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  it("creates visible persistent grants and completes approved configure and collaboration effects exactly once", async () => {
    const c = await canvas(),
      a = await agent(c, "write"),
      b = await agent(c, "read"),
      r = await resource(c);
    const caller = await start(a.id);
    const access = await caller.call("request_permission", {
      scope: { kind: "resource", nodeId: r.id, mode: "read" },
      reason: "need resource",
    });
    await decide(access.value.requestId);
    const grant = (await grantsFor(k.db.pool, a.id))[0];
    expect(grant!.mode).toBe("read");
    expect(grant!.source_link_id).toBeTruthy();
    const configure = await caller.call("configure_agent", {
      agentId: b.id,
      expectedRevision: b.revision,
      patch: { persona: "configured" },
    });
    await decide(configure.value.requestId);
    const replay = await caller.call(
      "configure_agent",
      { agentId: b.id, expectedRevision: b.revision, patch: { persona: "configured" } },
      configure.logical,
    );
    expect(replay.value.id).toBe(b.id);
    expect((await k.graph.queries.node(b.id)).revision).toBe(b.revision + 1);
    const message = await caller.call("send_message", {
      target: { kind: "agent", agentId: b.id },
      message: "do work",
    });
    expect(message.waiting).toBe("approval");
    await decide(message.value.requestId);
    await caller.call(
      "send_message",
      { target: { kind: "agent", agentId: b.id }, message: "do work" },
      message.logical,
    );
    expect(
      (await k.conversations.read.history((await k.conversations.read.forAgent(b.id)).id)).filter(
        (m) => m.role === "message",
      ),
    ).toHaveLength(1);
  });
  it("reroutes after a team move, rejects stale decisions, and keeps user escalation sticky", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      n = await agent(c, "admin"),
      b = await agent(m.id),
      unrelated = await resource(c);
    const child = await start(b.id);
    const pending = await child.call("request_permission", {
      scope: { kind: "role", role: "write" },
      reason: "private reason",
    });
    const original = await request(pending.value.requestId);
    await k.graph.updateNode(unrelated.id, {
      text: "unrelated edit",
      expectedRevision: unrelated.revision,
      idempotencyKey: key(),
    });
    expect((await request(original.id)).version).toBe(original.version);
    const move = await k.graph.submitMove({
      targetParentId: n.id,
      moves: [{ nodeId: b.id, x: 1, y: 1 }],
      idempotencyKey: key(),
    });
    expect((await request(original.id)).assigned_reviewer_id).toBe(n.id);
    await expect(
      k.access.decide(original.id, original.version, "approve", "stale"),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await k.graph.undoGraphOp(move.graphOpId);
    expect((await request(original.id)).assigned_reviewer_id).toBe(m.id);
    await decide(original.id, undefined, "escalate");
    await k.access.maintain();
    expect((await request(original.id)).assigned_reviewer_id).toBeNull();
    const sanitized = await k.access.list(c, { actor: { ...child.actor, agentId: m.id } });
    expect(JSON.stringify(sanitized)).not.toContain("private reason");
  });
  it("expires and cancels exact waiting calls, without cancelling unrelated agents", async () => {
    const c = await canvas(),
      a = await agent(c),
      b = await agent(c),
      x = await start(a.id),
      y = await start(b.id);
    const pending = await x.call("request_permission", {
      scope: { kind: "role", role: "write" },
      reason: "expire",
    });
    await k.runs.finish(x.run, "waiting", undefined, "approval");
    await k.db.pool.query("update approvals set expires_at=now()-interval '1 second' where id=$1", [
      pending.value.requestId,
    ]);
    await k.access.maintain();
    expect((await request(pending.value.requestId)).status).toBe("expired");
    expect((await k.runs.get(x.run.id)).state).toBe("queued");
    const req = await y.call("request_permission", {
      scope: { kind: "role", role: "admin" },
      reason: "stop",
    });
    await k.conversations.stop(b.id);
    expect((await request(req.value.requestId)).status).toBe("cancelled");
    expect((await k.runs.get(x.run.id)).cancel_requested_at).toBeNull();
    await expect(decide(req.value.requestId)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });
  it("falls back after manager deadline and recovers notices from a full queue", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      b = await agent(m.id),
      child = await start(b.id);
    const pending = await child.call("request_permission", {
      scope: { kind: "role", role: "write" },
      reason: "review",
    });
    const settings = await k.runs.settings.read();
    await k.runs.settings.save(settings.revision, { ...settings.policy, pendingPerCanvas: 1 });
    await k.access.maintain();
    expect(
      await k.conversations.activeRun((await k.conversations.read.forAgent(m.id)).id),
    ).toBeUndefined();
    const current = await k.runs.settings.read();
    await k.runs.settings.save(current.revision, settings.policy);
    await k.access.maintain();
    expect(
      await k.conversations.activeRun((await k.conversations.read.forAgent(m.id)).id),
    ).toBeTruthy();
    const reviewRun = (await k.runs.claim("notice-consumer"))!;
    await k.runs.fail(reviewRun, new Error("fixture model failure"));
    await k.access.maintain();
    expect(
      await k.conversations.activeRun((await k.conversations.read.forAgent(m.id)).id),
    ).toBeUndefined();
    await k.db.pool.query(
      "update approvals set review_due_at=now()-interval '1 second' where id=$1",
      [pending.value.requestId],
    );
    await k.access.maintain();
    expect(await request(pending.value.requestId)).toMatchObject({
      assigned_reviewer_id: null,
      route_reason: "manager_timeout",
    });
  });
  it("invalidates stale pending requests and permits a fresh request instead of recycling the stale one", async () => {
    const c = await canvas(),
      b = await agent(c),
      child = await start(b.id),
      r = await resource(c);
    const first = await child.call("request_permission", {
      scope: { kind: "role", role: "write" },
      reason: "before",
    });
    await connect(b.id, r.id);
    expect((await request(first.value.requestId)).status).toBe("invalidated");
    const second = await child.call("request_permission", {
      scope: { kind: "role", role: "write" },
      reason: "after",
    });
    expect(second.value.requestId).not.toBe(first.value.requestId);
    expect(second.waiting).toBe("approval");
  });
  it("uses owner identity on HTTP decisions and filters before paginating", async () => {
    const c = await canvas(),
      m = await agent(c, "admin"),
      b = await agent(m.id),
      child = await start(b.id);
    const pending = await child.call("request_permission", {
      scope: { kind: "role", role: "write" },
      reason: "http review",
    });
    const page = await k.access.list(c, { status: "pending", subjectId: b.id, limit: 1 });
    expect(page.total).toBe(1);
    const response = await app.inject({
      method: "POST",
      url: `/api/v2/agent-access/${pending.value.requestId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        decision: "approve",
        reason: "owner click",
        version: page.requests[0]!.version,
        reviewerId: m.id,
      },
    });
    expect(response.statusCode).toBe(200);
    expect((await request(pending.value.requestId)).decided_by).toBe("owner");
  });
});
describe("toolbar team control", () => {
  it("expands teams on the server, deduplicates roots, respects ordinary containers and stops approvals", async () => {
    const c = await canvas(),
      m = await agent(c, "read", false),
      b = await agent(m.id),
      d = await agent(b.id);
    const folder = await k.graph.command(
      c,
      key(),
      "test.group",
      {},
      { kind: "owner" },
      async (mutation) => ({
        id: await mutation.insert({
          kind: "group",
          parentId: m.id,
          title: "organizer",
          position: { x: 0, y: 0, width: 300, height: 300 },
        }),
      }),
    );
    const outside = await agent(folder.id);
    const actionKey = key();
    const response = await k.conversations.controlTeams([m.id, b.id], "start", actionKey, "en");
    expect(response.count).toBe(3);
    expect(response.agentIds).toEqual(expect.arrayContaining([m.id, b.id, d.id]));
    expect(response.agentIds).not.toContain(outside.id);
    expect(await k.conversations.controlTeams([m.id, b.id], "start", actionKey, "en")).toEqual(
      response,
    );
    expect((await k.conversations.controlTeams([m.id], "start", key(), "en")).count).toBe(0);
    expect((await k.conversations.controlTeams([m.id], "stop", key(), "en")).count).toBe(3);
    const child = await start(d.id),
      pending = await child.call("request_permission", {
        scope: { kind: "role", role: "admin" },
        reason: "team stop",
      });
    await k.conversations.controlTeams([m.id], "stop", key(), "en");
    expect((await request(pending.value.requestId)).status).toBe("cancelled");
  });
  it("queues more than 64 team members and rolls back a batch when capacity is insufficient", async () => {
    const c = await canvas(),
      m = await agent(c);
    for (let i = 0; i < 64; i++) await agent(m.id);
    const settings = await k.runs.settings.read();
    await k.runs.settings.save(settings.revision, { ...settings.policy, pendingPerCanvas: 64 });
    await expect(k.conversations.controlTeams([m.id], "start", key(), "en")).rejects.toMatchObject({
      code: "QUEUE_FULL",
    });
    expect((await k.db.pool.query("select 1 from runs where canvas_id=$1", [c])).rows).toHaveLength(
      0,
    );
    expect(
      (
        await k.db.pool.query(
          "select 1 from messages m join conversations c on c.id=m.conversation_id where c.canvas_id=$1",
          [c],
        )
      ).rows,
    ).toHaveLength(0);
    const current = await k.runs.settings.read();
    await k.runs.settings.save(current.revision, settings.policy);
    expect((await k.conversations.controlTeams([m.id], "start", key(), "en")).count).toBe(65);
    const other = await agent(await canvas());
    await expect(
      k.conversations.controlTeams([m.id, other.id], "stop", key(), "en"),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
