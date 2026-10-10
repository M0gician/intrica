import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

const api = `${API_URL}/api/v2`;
async function setup(page: Page, request: APIRequestContext, title: string) {
  const response = await request.post(`${api}/canvases`, {
    data: { title, idempotencyKey: randomUUID() },
  });
  expect(response.ok()).toBe(true);
  const board = (await response.json()).node;
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: title, exact: true }).click();
  return board.id as string;
}
async function create(request: APIRequestContext, parentId: string, extra: object = {}) {
  const response = await request.post(`${api}/nodes`, {
    data: {
      kind: "agent",
      parentId,
      title: "空间成员",
      agent: { persona: "核对资料", role: "read", enabled: false },
      position: { x: 80, y: 150, width: 240, height: 320 },
      idempotencyKey: randomUUID(),
      ...extra,
    },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).node;
}

test("两种输入框控件靠右，窄侧栏可收缩；移除对齐规则会复现偏移", async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const board = await setup(page, request, "输入框对齐");
  const agent = await create(request, board);
  await page.reload();
  await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
  const measurements = [];
  for (const mode of ["agent", "chat"]) {
    if (mode === "chat") await page.getByRole("button", { name: "模型会话", exact: true }).click();
    const toolbar = page.locator(".agent-composer-toolbar:visible");
    await expect(toolbar.locator(".model-trigger")).toContainText("acceptance");
    for (const width of [320, 640]) {
      const resize = (await page.getByRole("separator", { name: "调整侧栏宽度" }).boundingBox())!;
      await page.mouse.move(resize.x + resize.width / 2, resize.y + 100);
      await page.mouse.down();
      await page.mouse.move(1280 - width, resize.y + 100);
      await page.mouse.up();
      const bounds = await toolbar.evaluate((el) => {
        const ring = el.querySelector(".context-usage-ring")!.getBoundingClientRect();
        const model = el.querySelector(".model-trigger")!.getBoundingClientRect();
        const send = el.querySelector(".composer-action")!.getBoundingClientRect();
        return {
          left: ring.left,
          modelGap: model.left - ring.right,
          sendGap: send.left - model.right,
          rightGap: el.getBoundingClientRect().right - send.right,
          overflow: el.scrollWidth - el.clientWidth,
        };
      });
      expect(bounds.modelGap).toBeLessThanOrEqual(5);
      expect(bounds.sendGap).toBeLessThanOrEqual(5);
      expect(Math.abs(bounds.rightGap)).toBeLessThan(1);
      expect(bounds.overflow).toBeLessThanOrEqual(1);
      measurements.push({ mode, width, ...bounds });
    }
    const before = (await toolbar.locator(".context-usage-ring").boundingBox())!.x;
    const ablated = await page.addStyleTag({
      content: ".agent-composer-toolbar > .context-usage-ring { margin-left: 0; }",
    });
    const shift = before - (await toolbar.locator(".context-usage-ring").boundingBox())!.x;
    expect(shift).toBeGreaterThan(100);
    measurements.push({ mode, ablatedShift: shift });
    await ablated.evaluate((el) => el.parentNode?.removeChild(el));
  }
  await test.info().attach("composer-geometry", {
    body: JSON.stringify(measurements, null, 2),
    contentType: "application/json",
  });
  await page.screenshot({ path: test.info().outputPath("right-aligned-composer.png") });
});

test("网页地址可修改、失败可重试，预览填满不同宽度的卡片", async ({ page, request }) => {
  await page.route("**/api/v2/workspace/web-title?*", (route) => {
    const url = new URL(route.request().url()).searchParams.get("url")!;
    return route.fulfill({
      json: { title: url, imageUrl: `https://preview.test/${new URL(url).hostname}.svg` },
    });
  });
  await page.route("https://preview.test/*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#315c75"/><circle cx="300" cy="200" r="140" fill="#91bd77"/></svg>',
    }),
  );
  const board = await setup(page, request, "网页地址与预览");
  const node = await create(request, board, {
    kind: "text",
    agent: undefined,
    title: "网页链接",
    text: "[保留这个标题](https://example.com/old)",
    position: { x: 80, y: 150, width: 240, height: 180 },
  });
  const wide = await create(request, board, {
    kind: "text",
    agent: undefined,
    title: "宽卡片",
    text: "https://example.org/",
    position: { x: 360, y: 150, width: 360, height: 180 },
  });
  await page.reload();
  const card = page.locator(`[data-node-id="${node.id}"]`);
  const gaps = [];
  for (const id of [node.id, wide.id]) {
    const current = page.locator(`[data-node-id="${id}"]`);
    await expect(current.locator(".bookmark-card-preview img")).toBeVisible();
    const gap = await current.evaluate((el) => {
      const body = el.querySelector(".node-card-body")!.getBoundingClientRect();
      const shot = el.querySelector(".bookmark-card-preview img")!.getBoundingClientRect();
      return { left: shot.left - body.left, right: body.right - shot.right };
    });
    expect(Math.abs(gap.left)).toBeLessThan(1);
    expect(Math.abs(gap.right)).toBeLessThan(1);
    gaps.push(gap);
  }
  // Preview pixels are canvas content, not a native image export/import gesture.
  await page.evaluate(() => {
    document.documentElement.dataset.previewDrags = "0";
    document.addEventListener("dragstart", () => {
      document.documentElement.dataset.previewDrags = String(
        Number(document.documentElement.dataset.previewDrags) + 1,
      );
    });
  });
  const preview = (await card.locator("img").boundingBox())!;
  await page.mouse.move(preview.x + 60, preview.y + 60);
  await page.mouse.down();
  await page.mouse.move(preview.x + 100, preview.y + 90, { steps: 4 });
  await page.mouse.up();
  expect(await page.locator("html").getAttribute("data-preview-drags")).toBe("0");
  await expect(page.locator(".node-card")).toHaveCount(2);
  await expect(card).toHaveCSS("left", `${node.position.x}px`);
  await expect(card).toHaveCSS("top", `${node.position.y}px`);
  await card.dblclick();
  await page.getByRole("button", { name: "详情", exact: true }).click();
  const address = page.getByRole("textbox", { name: "网页地址", exact: true });
  await address.fill("javascript:alert(1)");
  await page.getByRole("button", { name: "保存地址" }).click();
  await expect(page.locator(".bookmark-address [role=alert]")).toContainText("有效");
  await expect(card.locator("img")).toHaveAttribute("src", /example.com/);
  await address.fill("example.net/new");
  await page.route(`**/api/v2/nodes/${node.id}`, (route) =>
    route.request().method() === "PATCH" ? route.abort() : route.continue(),
  );
  await page.getByRole("button", { name: "保存地址" }).click();
  await expect(page.locator(".bookmark-address [role=alert]")).toContainText("草稿已保留");
  await expect(address).toHaveValue("example.net/new");
  await page.unroute(`**/api/v2/nodes/${node.id}`);
  await page.getByRole("button", { name: "保存地址" }).click();
  await expect(address).toHaveValue("https://example.net/new");
  await expect(card.locator("img")).toHaveAttribute("src", /example.net/);
  await expect(card.locator("header")).toContainText("保留这个标题");
  const saved = (await (await request.get(`${api}/nodes/${node.id}/content`)).json()).node;
  expect(saved.text).toBe("https://example.net/new");
  expect(saved.title).toBe("保留这个标题");
  await page.reload();
  await card.dblclick();
  await page.getByRole("button", { name: "详情", exact: true }).click();
  await expect(address).toHaveValue("https://example.net/new");
  await page.screenshot({ path: test.info().outputPath("editable-full-width-preview.png") });
  const ablated = await page.addStyleTag({
    content:
      ".bookmark-card-preview { flex: none; aspect-ratio: 16 / 10; height: 124px; align-self: flex-start; }",
  });
  const gap = await card.evaluate(
    (el) =>
      el.querySelector(".node-card-body")!.getBoundingClientRect().right -
      el.querySelector(".bookmark-card-preview")!.getBoundingClientRect().right,
  );
  expect(gap).toBeGreaterThan(30);
  await ablated.evaluate((el) => el.parentNode?.removeChild(el));
  await test.info().attach("preview-geometry", {
    body: JSON.stringify({ gaps, ablatedRightGap: gap }, null, 2),
    contentType: "application/json",
  });
});

test("拖入与拖出 Agent 更新容器预览，同步管理关系并可撤销", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const board = await setup(page, request, "拖动 Agent 容器");
  const parent = await create(request, board, {
    title: "空间容器",
    position: { x: 480, y: 150, width: 240, height: 320 },
  });
  const child = await create(request, board);
  await page.reload();
  const parentCard = page.locator(`.canvas-world > [data-node-id="${parent.id}"]`);
  const childCard = page.locator(`[data-node-id="${child.id}"]`);
  const originalWidth = (await parentCard.boundingBox())!.width;
  const from = (await childCard.locator(".agent-photo-card").boundingBox())!;
  const target = (await parentCard.boundingBox())!;
  await page.mouse.move(from.x + 60, from.y + 70);
  await page.mouse.down();
  await page.mouse.move(target.x + 100, target.y + 100, { steps: 10 });
  await expect(parentCard).toHaveClass(/drop-target/);
  await page.mouse.up();
  const faces = parentCard.getByRole("button", { name: "进入 Agent Team，1 位成员" });
  await expect(faces).toBeVisible();
  expect((await parentCard.boundingBox())!.width).toBeGreaterThan(originalWidth);
  const getChild = async () =>
    (await (await request.get(`${api}/nodes/${child.id}/content`)).json()).node;
  expect((await getChild()).parentId).toBe(parent.id);
  expect((await getChild()).managerId).toBe(parent.id);
  await faces.click();
  const overlay = page.getByRole("region", { name: /临时内部空间/ });
  await expect(overlay.locator(`[data-node-id="${child.id}"]`)).toBeVisible();
  if (await page.getByRole("button", { name: "关闭详情侧栏" }).isVisible())
    await page.getByRole("button", { name: "关闭详情侧栏" }).click();
  await page.screenshot({ path: test.info().outputPath("dragged-agent-container.png") });
  const inner = (await childCard.locator(".agent-photo-card").boundingBox())!;
  // Alt detaches a member from the open inner space, matching the canvas gesture.
  await page.keyboard.down("Alt");
  await page.mouse.move(inner.x + 60, inner.y + 70);
  await page.mouse.down();
  await page.mouse.move(80, 900, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect.poll(async () => (await getChild()).parentId).toBe(board);
  await expect(faces).toHaveCount(0);
  expect((await getChild()).managerId ?? null).toBeNull();
  expect((await parentCard.boundingBox())!.width).toBeCloseTo(originalWidth, 0);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.poll(async () => (await getChild()).parentId).toBe(parent.id);
  expect((await getChild()).managerId).toBe(parent.id);
  await expect(faces).toBeVisible();
});
