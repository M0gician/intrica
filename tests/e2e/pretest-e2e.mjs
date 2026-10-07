import { execSync } from "node:child_process";
import pg from "pg";
import { ADMIN_URL, DATABASE_URL } from "./environment.mjs";

if (!process.env.INTRICA_E2E_SKIP_BUILD)
  execSync("pnpm --filter @intrica/server... --filter @intrica/web... build", { stdio: "inherit" });
const { Database } = await import("../../apps/server/dist/index.js");
const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();
if (!(await admin.query("select 1 from pg_database where datname='intrica_e2e'")).rowCount)
  await admin.query("create database intrica_e2e");
await admin.end();
const db = new Database(DATABASE_URL);
await db.pool.query("drop schema if exists intrica cascade");
await db.migrate();
await db.pool.query("insert into canvases(id,title) values('canvas-e2e','我的画布')");
await db.close();
