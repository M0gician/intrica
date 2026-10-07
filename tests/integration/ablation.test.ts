import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createKernel } from "@intrica/server";
import pg from "pg";
import { expect, it } from "vitest";
import { SceneProjection } from "../../apps/web/src/features/canvas/scene.js";
import { intersects, SpatialIndex } from "../../apps/web/src/features/canvas/spatial-index.js";

const percentile = (values: number[], p = 0.95) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)]!;
it("measures production query shape, command cost, culling and stable node projections", async () => {
  const admin = new pg.Client({
    connectionString: process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres",
  });
  await admin.connect();
  const name = `intrica_ablate_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`create database ${name}`);
  const url = new URL(process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres");
  url.pathname = `/${name}`;
  const dir = await mkdtemp(join(tmpdir(), "intrica-ablation-"));
  const k = await createKernel({
    databaseUrl: url.href,
    dataDir: dir,
    model: { kind: "mock", supportsVision: true, streamDelayMs: 0 },
    host: "127.0.0.1",
    port: 0,
    accessToken: "ablation",
    webRoot: "",
    serverName: "ablation",
    worker: false,
    deployment: "source",
  });
  try {
    const c = (await k.graph.createCanvas({ title: "10k 画布", idempotencyKey: "scale" })).node.id;
    await k.db.pool.query(
      "insert into nodes(id,canvas_id,sort_key,kind,body,x,y,w,h) select 'bench-'||i,$1,i*1024,'text',jsonb_build_object('title','Node '||i,'text',repeat('x',8192)),(i%100)*300,(i/100)*200,240,160 from generate_series(1,10000)i",
      [c],
    );
    await k.db.pool.query(
      "insert into runs(id,canvas_id,subject_id,kind,state,frozen_input,cause_id) select 'history-'||i,$1,'history-subject-'||(i%32),'conversation','succeeded','{}','history-'||i from generate_series(1,100000)i",
      [c],
    );
    await k.db.pool.query("analyze nodes");
    await k.db.pool.query("analyze runs");
    const bootstrapTimes: number[] = [],
      fullTimes: number[] = [],
      commandTimes: number[] = [];
    let metadata = await k.bootstrap(c),
      full = await k.graph.queries.snapshot(c, true);
    for (let i = 0; i < 10; i++) {
      let now = performance.now();
      metadata = await k.bootstrap(c);
      bootstrapTimes.push(performance.now() - now);
      now = performance.now();
      full = await k.graph.queries.snapshot(c, true);
      fullTimes.push(performance.now() - now);
    }
    for (let i = 0; i < 20; i++) {
      const now = performance.now();
      await k.graph.submitMove({
        targetParentId: c,
        moves: [{ nodeId: "bench-1", x: i, y: 10 }],
        idempotencyKey: `move-${i}`,
      });
      commandTimes.push(performance.now() - now);
    }
    const nodes = metadata.nodes.filter((n) => n.parentId !== null),
      byId = new Map(nodes.map((n) => [n.id, n]));
    const before = performance.now(),
      index = new SpatialIndex(nodes),
      indexBuild = performance.now() - before;
    const indexed: number[] = [],
      linear: number[] = [],
      visible: number[] = [];
    for (let i = 0; i < 300; i++) {
      const viewport = { x: (i % 60) * 300, y: (i % 40) * 200, width: 1440, height: 960 };
      let now = performance.now();
      const found = index.query(viewport);
      indexed.push(performance.now() - now);
      now = performance.now();
      const all = nodes.filter((n) => intersects(n.position, viewport));
      linear.push(performance.now() - now);
      expect(new Set(found.map((n) => n.id))).toEqual(new Set(all.map((n) => n.id)));
      visible.push(found.length);
    }
    const projection = new SceneProjection();
    const initial = projection.project(byId, new Map());
    const changed = new Map(byId);
    changed.set("bench-1", { ...byId.get("bench-1")!, title: "edited" });
    const projected = projection.project(changed, new Map());
    const retained = nodes.filter(
      (n) => initial.nodes.get(n.id) === projected.nodes.get(n.id),
    ).length;
    const uncached = new SceneProjection().project(changed, new Map());
    const uncachedRetained = nodes.filter(
      (n) => initial.nodes.get(n.id) === uncached.nodes.get(n.id),
    ).length;
    const payload = (
      await k.db.pool.query(
        "select payload from canvas_events where canvas_id=$1 and type='graph.changed' order by seq desc limit 1",
        [c],
      )
    ).rows[0].payload;
    const report = {
      date: new Date().toISOString(),
      environment: {
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        node: process.version,
        postgres: (await k.db.pool.query("show server_version")).rows[0].server_version,
      },
      dataset: { nodes: 10000, historyRuns: 100000, bodyBytes: 8192 },
      bootstrap: {
        p95Ms: percentile(bootstrapTimes),
        metadataBytes: Buffer.byteLength(JSON.stringify(metadata)),
        fullP95Ms: percentile(fullTimes),
        fullBytes: Buffer.byteLength(JSON.stringify(full)),
      },
      commands: {
        p95Ms: percentile(commandTimes),
        deltaNodes: payload.nodes.length,
        deltaBytes: Buffer.byteLength(JSON.stringify(payload)),
      },
      scene: {
        indexBuildMs: indexBuild,
        indexedP95Ms: percentile(indexed),
        linearP95Ms: percentile(linear),
        mountedCandidateP95: percentile(visible),
        withoutCulling: nodes.length,
        retainedNodeObjects: retained,
        withoutProjectionCache: uncachedRetained,
      },
    };
    await mkdir(resolve("test-results"), { recursive: true });
    await writeFile(
      resolve("test-results/implementation-results.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    expect(report.bootstrap.metadataBytes).toBeLessThan(report.bootstrap.fullBytes / 5);
    expect(report.commands.deltaNodes).toBe(1);
    expect(retained).toBe(9999);
    expect(uncachedRetained).toBe(0);
    expect(report.scene.mountedCandidateP95).toBeLessThan(100);
    expect(report.bootstrap.p95Ms).toBeLessThan(1000);
    expect(report.commands.p95Ms).toBeLessThan(200);
  } finally {
    await k.db.close();
    await admin.query(`drop database ${name} with(force)`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
