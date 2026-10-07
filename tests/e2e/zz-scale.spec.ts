import { randomUUID } from "node:crypto";
import { arch, cpus, platform } from "node:os";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { API_URL, DATABASE_URL } from "./environment.mjs";

test("10k production canvas keeps DOM bounded while panning", async ({
  page,
  request,
  browser,
}) => {
  const title = `Scale ${randomUUID()}`;
  const response = await request.post(`${API_URL}/api/v2/canvases`, {
    data: { title, idempotencyKey: randomUUID() },
  });
  expect(response.ok()).toBe(true);
  const canvas = (await response.json()).node.id;
  const db = new pg.Client({
    connectionString: DATABASE_URL,
    options: "-c search_path=intrica,public",
  });
  await db.connect();
  try {
    await db.query(
      "insert into nodes(id,canvas_id,sort_key,kind,body,x,y,w,h) select $1||'-'||i,$1,i*1024,'text',jsonb_build_object('title','Node '||i,'text',repeat('x',8192)),(i%100)*300,(i/100)*240,240,160 from generate_series(1,10000)i",
      [canvas],
    );
    await db.query(
      "insert into nodes(id,canvas_id,sort_key,kind,body,x,y,w,h) select $1||'-agent-'||i,$1,(10000+i)*1024,'agent',jsonb_build_object('title','Agent '||i),i*300,25000,240,160 from generate_series(1,32)i",
      [canvas],
    );
    await db.query(
      'insert into agent_configs(node_id,config,enabled) select id,\'{"persona":"scale","role":"read","enabled":false}\',false from nodes where canvas_id=$1 and kind=\'agent\'',
      [canvas],
    );
  } finally {
    await db.end();
  }
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  const started = Date.now();
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(page.locator(`[data-node-id="${canvas}-1"]`)).toBeVisible();
  const loadedMs = Date.now() - started;
  const sample = await page.evaluate(async () => {
    const viewport = document.querySelector(".canvas-viewport")!;
    const frames: number[] = [],
      counts: number[] = [];
    let previous = performance.now();
    for (let i = 0; i < 180; i++) {
      await new Promise<void>((done) =>
        requestAnimationFrame((now) => {
          if (i > 10) frames.push(now - previous);
          previous = now;
          counts.push(document.querySelectorAll(".canvas-world [data-node-id]").length);
          viewport.dispatchEvent(
            new WheelEvent("wheel", {
              deltaX: 18,
              deltaY: 8,
              bubbles: true,
              cancelable: true,
              clientX: 600,
              clientY: 400,
            }),
          );
          done();
        }),
      );
    }
    const ordered = frames.sort((a, b) => a - b);
    return {
      frameP95Ms: ordered[Math.floor(ordered.length * 0.95)]!,
      frameMedianMs: ordered[Math.floor(ordered.length * 0.5)]!,
      frames: frames.length,
      maxMountedNodes: Math.max(...counts),
      totalDomElements: document.querySelectorAll("*").length,
      minMountedNodes: Math.min(...counts),
      framesOver33ms: frames.filter((v) => v > 33).length,
    };
  });
  expect(sample.maxMountedNodes).toBeLessThan(150);
  expect(sample.minMountedNodes).toBeGreaterThan(0);
  expect(sample.totalDomElements).toBeLessThan(2000);
  const report = {
    date: new Date().toISOString(),
    environment: {
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      browser: browser.version(),
      build: process.env.INTRICA_E2E_PREVIEW ? "production" : "development",
      viewport: page.viewportSize(),
    },
    dataset: { textNodes: 10000, configuredAgents: 32, bodyBytes: 8192, activeAgents: 0 },
    loadedMs,
    ...sample,
  };
  await test.info().attach("browser-results.json", {
    body: JSON.stringify(report),
    contentType: "application/json",
  });
});
