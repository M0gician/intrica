import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import pg from "pg";
import { API_URL, DATABASE_URL } from "./environment.mjs";

async function canvas(request: APIRequestContext) {
  const title = `Interaction ${randomUUID()}`;
  const response = await request.post(`${API_URL}/api/v2/canvases`, {
    data: { title, idempotencyKey: randomUUID() },
  });
  expect(response.ok()).toBe(true);
  return { id: (await response.json()).node.id as string, title };
}

async function openCanvas(page: Page, title: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "切换画布", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索或新建画布" }).fill(title);
  await page.getByRole("button", { name: title, exact: true }).click();
}

async function createNode(request: APIRequestContext, parentId: string, title: string, x: number) {
  const response = await request.post(`${API_URL}/api/v2/nodes`, {
    data: {
      kind: "text",
      parentId,
      title,
      text: title,
      position: { x, y: 150, width: 240, height: 160 },
      idempotencyKey: randomUUID(),
    },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).node;
}

test("selection preserves workspace navigation and explicit inspection opens details", async ({
  page,
  request,
}) => {
  const board = await canvas(request);
  const first = await createNode(request, board.id, "First", 70);
  const second = await createNode(request, board.id, "Second", 370);
  await openCanvas(page, board.title);
  const a = page.locator(`[data-node-id="${first.id}"]`);
  const b = page.locator(`[data-node-id="${second.id}"]`);
  await a.click();
  await expect(a).toHaveClass(/selected/);
  await expect(page.locator(".workspace-panel")).toBeHidden();
  await a.dblclick();
  await expect(page.locator(".workspace-panel")).toBeVisible();
  await b.click({ modifiers: ["Shift"] });
  await expect(page.getByRole("toolbar", { name: "选中操作栏" })).toContainText("已选择 2 项");
  await expect(page.locator(".workspace-panel")).toBeVisible();
  await page.getByRole("button", { name: "关闭详情侧栏" }).click();
  await page.locator(".canvas-viewport").focus();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(page.getByRole("toolbar", { name: "选中操作栏" })).toContainText("已选择 2 项");
  await expect(page.locator(".workspace-panel")).toBeHidden();
});

test("overlapping cards preserve their pointer target while gaining focus", async ({
  page,
  request,
}) => {
  const board = await canvas(request);
  await createNode(request, board.id, "Covered note", 100);
  const top = await createNode(request, board.id, "Front note", 100);
  await openCanvas(page, board.title);
  const card = page.locator(`[data-node-id="${top.id}"]`);
  await card.dblclick({ position: { x: 100, y: 70 } });
  await expect(page.getByRole("textbox", { name: "节点标题", exact: true })).toHaveValue(
    "Front note",
  );
  await expect(card).toHaveClass(/selected/);
});

test("creation completion preserves the current canvas after navigation", async ({
  page,
  request,
}) => {
  const first = await canvas(request);
  const second = await canvas(request);
  await openCanvas(page, first.title);
  let release!: () => void;
  let captured!: (id: string) => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const committed = new Promise<string>((resolve) => {
    captured = resolve;
  });
  await page.route("**/api/v2/nodes", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    captured((await response.json()).node.id);
    await gate;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "新建节点", exact: true }).click();
  await page.getByRole("menuitem", { name: "文字", exact: true }).click();
  const createdId = await committed;
  await page.getByRole("button", { name: "切换画布", exact: true }).click();
  await page.getByRole("button", { name: second.title, exact: true }).click();
  await expect(page.getByRole("button", { name: "切换画布", exact: true })).toContainText(
    second.title,
  );
  const delivered = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v2/nodes",
  );
  release();
  await delivered;
  await expect(page.locator(".workspace-panel")).toBeHidden();
  await expect(page.locator(".node-card.selected")).toHaveCount(0);
  const snapshot = await (
    await request.get(`${API_URL}/api/v2/bootstrap?canvasId=${first.id}`)
  ).json();
  expect(snapshot.nodes.some((node: { id: string }) => node.id === createdId)).toBe(true);
});

test("a gesture ignores other pointers and cancellation never commits a move", async ({
  page,
  request,
}) => {
  const board = await canvas(request);
  const node = await createNode(request, board.id, "Pointer owner", 100);
  await openCanvas(page, board.title);
  const card = page.locator(`[data-node-id="${node.id}"]`);
  const header = (await card.locator("header").boundingBox())!;
  await page.mouse.move(header.x + 50, header.y + 15);
  await page.mouse.down();
  await page.evaluate(({ x, y }) => {
    window.dispatchEvent(
      new PointerEvent("pointermove", { pointerId: 777, clientX: x + 100, clientY: y + 70 }),
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", { pointerId: 777, clientX: x + 100, clientY: y + 70 }),
    );
  }, header);
  await expect(page.locator(".node-dragging")).toHaveCount(0);
  await page.mouse.move(header.x + 90, header.y + 40);
  await expect(page.locator(".node-dragging")).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.locator(".node-dragging")).toHaveCount(0);
  await page.mouse.up();
  const snapshot = await (
    await request.get(`${API_URL}/api/v2/bootstrap?canvasId=${board.id}`)
  ).json();
  expect(snapshot.nodes.find((item: { id: string }) => item.id === node.id).position).toEqual(
    node.position,
  );
  await card.locator("header").hover();
  await page.mouse.down();
  await page.mouse.move(header.x + 150, header.y + 60);
  await page.mouse.up();
  await expect
    .poll(async () => {
      const result = await (
        await request.get(`${API_URL}/api/v2/bootstrap?canvasId=${board.id}`)
      ).json();
      return result.nodes.find((item: { id: string }) => item.id === node.id).position.x;
    })
    .toBeGreaterThan(node.position.x);
});

test("10k selected nodes and 20k edges keep dragging bounded by the viewport", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const board = await canvas(request);
  const db = new pg.Client({
    connectionString: DATABASE_URL,
    options: "-c search_path=intrica,public",
  });
  await db.connect();
  try {
    await db.query(
      "insert into nodes(id,canvas_id,sort_key,kind,body,x,y,w,h) select $1||'-'||i,$1,i*1024,'text',jsonb_build_object('title','Node '||i,'text',repeat('x',256)),(i%100)*300+40,(i/100)*240+120,240,160 from generate_series(1,10000)i",
      [board.id],
    );
    await db.query(
      "insert into edges(id,canvas_id,from_id,to_id,kind) select $1||'-edge-'||i||'-'||distance,$1,$1||'-'||i,$1||'-'||(1+(i+distance-1)%10000),'user_link' from generate_series(1,10000)i cross join (values(1),(100)) as distances(distance)",
      [board.id],
    );
  } finally {
    await db.end();
  }
  await openCanvas(page, board.title);
  const card = page.locator(`[data-node-id="${board.id}-1"]`);
  await expect(card).toBeVisible();
  await page.locator(".canvas-viewport").focus();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(page.getByRole("toolbar", { name: "选中操作栏" })).toContainText("10000");
  expect(await page.locator(".canvas-world [data-node-id]").count()).toBeLessThan(150);
  const header = (await card.locator("header").boundingBox())!;
  await page.mouse.move(header.x + 40, header.y + 15);
  await page.mouse.down();
  await page.mouse.move(header.x + 70, header.y + 40);
  await expect(page.locator("[data-canvas-drag-count]")).toHaveAttribute(
    "data-canvas-drag-count",
    "10000",
  );
  const sample = await page.evaluate(async () => {
    const frames: number[] = [];
    const counts: number[] = [];
    let previous = performance.now();
    for (let index = 0; index < 90; index++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame((now) => {
          if (index > 10) frames.push(now - previous);
          previous = now;
          counts.push(document.querySelectorAll(".canvas-world [data-node-id]").length);
          window.dispatchEvent(
            new PointerEvent("pointermove", {
              pointerId: 1,
              clientX: 500 + index,
              clientY: 220 + index / 2,
            }),
          );
          resolve();
        }),
      );
    }
    frames.sort((a, b) => a - b);
    return {
      p95FrameMs: frames[Math.floor(frames.length * 0.95)]!,
      maxMounted: Math.max(...counts),
    };
  });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator("[data-canvas-drag-count]")).toHaveCount(0);
  expect(sample.maxMounted).toBeLessThan(150);
  expect(sample.p95FrameMs).toBeLessThan(50);
  console.log("Canvas performance:", JSON.stringify(sample));
  await test.info().attach("canvas-performance.json", {
    body: JSON.stringify(sample),
    contentType: "application/json",
  });
});
