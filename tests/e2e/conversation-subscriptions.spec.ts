import { randomUUID } from "node:crypto";
import type { Node } from "@intrica/contracts";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

async function workspace(page: Page, request: APIRequestContext) {
  const title = `会话订阅 ${randomUUID().slice(0, 8)}`;
  const response = await request.post(`${API_URL}/api/v2/canvases`, {
    data: { title, idempotencyKey: randomUUID() },
  });
  expect(response.ok()).toBe(true);
  const canvas = (await response.json()).node as Node;
  const create = async (kind: "text" | "agent", x: number) => {
    const response = await request.post(`${API_URL}/api/v2/nodes`, {
      data: {
        kind,
        parentId: canvas.id,
        title: kind === "agent" ? "核对员" : "资料",
        ...(kind === "agent"
          ? { agent: { role: "read", enabled: false, persona: "核对事实" } }
          : { text: "原始内容" }),
        position: { x, y: 160, width: 240, height: 180 },
        idempotencyKey: randomUUID(),
      },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()).node as Node;
  };
  const note = await create("text", 80);
  const agent = await create("agent", 370);
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(page.locator(`[data-node-id="${note.id}"]`)).toBeVisible();
  return { canvas, note, agent };
}

test("图内容更新只刷新相关实体，会话与审批读取保持独立", async ({ page, request }) => {
  let { note } = await workspace(page, request);
  const reads: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "GET" &&
      /\/api\/v2\/(conversations\/|canvas-agents\/|agent-access)/.test(path)
    )
      reads.push(path);
  });
  await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
  const initial = Promise.all([
    page.waitForResponse((response) =>
      /^\/api\/v2\/conversations\/[^/]+$/.test(new URL(response.url()).pathname),
    ),
    page.waitForResponse((response) =>
      /\/conversations\/[^/]+\/navigation$/.test(new URL(response.url()).pathname),
    ),
  ]);
  await page.getByRole("button", { name: "模型会话", exact: true }).click();
  await initial;
  await expect(page.getByLabel("模型问题")).toBeVisible();
  const focused = Promise.all([
    page.waitForResponse((response) =>
      /^\/api\/v2\/conversations\/[^/]+$/.test(new URL(response.url()).pathname),
    ),
    page.waitForResponse((response) =>
      /\/conversations\/[^/]+\/navigation$/.test(new URL(response.url()).pathname),
    ),
  ]);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await focused;
  reads.length = 0;
  for (let index = 0; index < 8; index++) {
    const response = await request.patch(`${API_URL}/api/v2/nodes/${note.id}`, {
      data: {
        title: `资料 ${index}`,
        expectedRevision: note.revision,
        idempotencyKey: randomUUID(),
      },
    });
    expect(response.ok()).toBe(true);
    note = (await response.json()).node;
    await expect(page.locator(`[data-node-id="${note.id}"] .node-card-title`)).toHaveText(
      `资料 ${index}`,
    );
  }
  await page.waitForTimeout(200);
  expect(reads).toEqual([]);
  await test.info().attach("targeted-read-counts.json", {
    body: JSON.stringify({ graphCommands: 8, unrelatedReads: reads.length }),
    contentType: "application/json",
  });
});

test("隐藏 Agent 面板暂停读取并保留服务器执行结果", async ({ page, request }) => {
  const { agent } = await workspace(page, request);
  await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
  await expect(page.getByLabel("Agent 任务")).toBeVisible();
  await page.getByRole("button", { name: "文件", exact: true }).click();
  let feedReads = 0;
  let navigationReads = 0;
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      /\/conversations\/[^/]+\/navigation/.test(new URL(request.url()).pathname)
    )
      navigationReads++;
    if (
      request.method() === "GET" &&
      new URL(request.url()).pathname === `/api/v2/canvas-agents/${agent.id}`
    )
      feedReads++;
  });
  const started = await request.post(`${API_URL}/api/v2/canvas-agents/${agent.id}/run`, {
    data: { message: "核对画布资料并汇报", idempotencyKey: randomUUID() },
  });
  expect(started.ok()).toBe(true);
  await expect
    .poll(async () => {
      const response = await request.get(`${API_URL}/api/v2/canvas-agents/${agent.id}`);
      return (await response.json()).runState;
    })
    .toBe("succeeded");
  expect(feedReads).toBe(0);
  expect(navigationReads).toBe(0);
  await page.getByRole("button", { name: "详情", exact: true }).click();
  await expect(page.getByLabel("Agent 共享会话")).toContainText("模拟会话第 1 轮");
  expect(feedReads).toBeGreaterThan(0);
});

test("编辑器依据服务器版本连续保存，重新打开后读取完整内容", async ({ page, request }) => {
  const { note } = await workspace(page, request);
  await page.locator(`[data-node-id="${note.id}"]`).dblclick();
  await page.getByRole("button", { name: "查看源码", exact: true }).click();
  const editor = page.getByLabel("编辑节点正文");
  await editor.fill("第一次保存");
  await expect
    .poll(async () => {
      const response = await request.get(`${API_URL}/api/v2/nodes/${note.id}/content`);
      return (await response.json()).node.text;
    })
    .toBe("第一次保存");
  await editor.fill("第二次保存");
  await expect
    .poll(async () => {
      const response = await request.get(`${API_URL}/api/v2/nodes/${note.id}/content`);
      return (await response.json()).node.text;
    })
    .toBe("第二次保存");
  await expect(page.locator(".document-toolbar [role=status]")).toHaveText("已保存");
  await page.reload();
  await page.locator(`[data-node-id="${note.id}"]`).dblclick();
  await expect(page.locator(".document-preview")).toContainText("第二次保存");
});

test("内容读取跨越快照刷新时，编辑器继续读取当前版本", async ({ page, request }) => {
  const { canvas, note } = await workspace(page, request);
  let release!: () => void;
  let received!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const captured = new Promise<void>((resolve) => {
    received = resolve;
  });
  let reads = 0;
  await page.route(`**/api/v2/nodes/${note.id}/content`, async (route) => {
    const first = ++reads === 1;
    const response = await route.fetch();
    if (first) {
      received();
      await held;
    }
    await route.fulfill({ response });
  });
  try {
    await page.locator(`[data-node-id="${note.id}"]`).dblclick();
    await captured;
    const renamed = await request.patch(`${API_URL}/api/v2/canvases/${canvas.id}`, {
      data: {
        title: `${canvas.title} 已核对`,
        expectedTitle: canvas.title,
        idempotencyKey: randomUUID(),
      },
    });
    expect(renamed.ok()).toBe(true);
    await expect(page.locator(".document-preview")).toContainText("原始内容");
    expect(reads).toBeGreaterThanOrEqual(2);
    release();
    await expect(page.locator(".document-preview")).toContainText("原始内容");
  } finally {
    release();
  }
});

test("迟到的正文读取不会阻止新版本完整内容加载", async ({ page, request }) => {
  const { note } = await workspace(page, request);
  let release!: () => void;
  let received!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const captured = new Promise<void>((resolve) => {
    received = resolve;
  });
  let reads = 0;
  await page.route(`**/api/v2/nodes/${note.id}/content`, async (route) => {
    const first = ++reads === 1;
    const response = await route.fetch();
    if (first) {
      received();
      await held;
    }
    await route.fulfill({ response });
  });
  try {
    await page.locator(`[data-node-id="${note.id}"]`).dblclick();
    await captured;
    const updated = await request.patch(`${API_URL}/api/v2/nodes/${note.id}`, {
      data: {
        title: "新版资料",
        text: `${"正文详细证据。".repeat(100)}\n\n正文末尾已核实`,
        expectedRevision: note.revision,
        idempotencyKey: randomUUID(),
      },
    });
    expect(updated.ok()).toBe(true);
    await expect(page.locator(`[data-node-id="${note.id}"] .node-card-title`)).toHaveText(
      "新版资料",
    );
    release();
    await expect(page.locator(".document-preview")).toContainText("正文末尾已核实");
    expect(reads).toBeGreaterThanOrEqual(2);
  } finally {
    release();
  }
});
