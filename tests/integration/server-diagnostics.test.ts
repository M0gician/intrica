import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "@intrica/server";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

const adminUrl = process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres";
const name = `intrica_diagnostics_${randomUUID().replaceAll("-", "")}`;
const token = randomUUID();
let app: Awaited<ReturnType<typeof buildServer>>, admin: pg.Client, dir: string;
beforeAll(async () => {
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  dir = await mkdtemp(join(tmpdir(), "intrica-diagnostics-"));
  app = await buildServer({
    databaseUrl: url.href,
    dataDir: dir,
    accessToken: token,
    worker: false,
    model: { kind: "mock", streamDelayMs: 0, supportsVision: false },
  });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await admin.query(`drop database if exists ${name} with(force)`);
  await admin.end();
  if (dir) await rm(dir, { recursive: true, force: true });
});

it("server diagnosis is authenticated, read-only, secret-free and counts only live approvals", async () => {
  expect(
    (await app.inject({ method: "GET", url: "/api/v2/settings/diagnostics" })).statusCode,
  ).toBe(401);
  const k = app.kernel;
  const canvas = (
    await k.graph.createCanvas({ title: "diagnostics", idempotencyKey: randomUUID() })
  ).node.id;
  const deleted = (await k.graph.createCanvas({ title: "deleted", idempotencyKey: randomUUID() }))
    .node.id;
  await k.db.pool.query("update canvases set deleted_at=now() where id=$1", [deleted]);
  await k.db.pool.query(
    `insert into approvals(id,canvas_id,subject_id,action,basis,status,expires_at,reason) values
    ('visible',$1,'agent','{}','{}','pending',now()+interval '1 hour',''),
    ('expired',$1,'agent','{}','{}','pending',now()-interval '1 hour',''),
    ('gone',$2,'agent','{}','{}','pending',now()+interval '1 hour','')`,
    [canvas, deleted],
  );
  const response = await app.inject({
    method: "GET",
    url: "/api/v2/settings/diagnostics",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json()).toMatchObject({
    hostname: expect.any(String),
    platform: process.platform,
    checkedAt: expect.any(String),
    agents: 0,
    queued: 0,
    pendingApprovals: 1,
    unknownTools: 0,
  });
  expect(response.json()).toHaveProperty("isolation");
  expect(["enabled", "disabled", "unavailable"]).toContain(response.json().sandboxStatus);
  expect(response.body).not.toContain(token);
  expect(response.body).not.toContain(dir);
  expect(
    (await k.db.pool.query("select status from approvals where id='visible'")).rows[0].status,
  ).toBe("pending");
});
