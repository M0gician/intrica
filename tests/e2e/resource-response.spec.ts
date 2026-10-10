import { randomUUID } from "node:crypto";
import type { Node, ResourceResponseStatus } from "@intrica/contracts";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

const key = () => randomUUID();
async function scene(page: Page, request: APIRequestContext, missingModel = false) {
  const title = `Resource response ${key().slice(0, 8)}`;
  const board = (
    await (
      await request.post(`${API_URL}/api/v2/canvases`, {
        data: { title, idempotencyKey: key() },
      })
    ).json()
  ).node as Node;
  const a = (
    await (
      await request.post(`${API_URL}/api/v2/nodes`, {
        data: {
          kind: "agent",
          parentId: board.id,
          position: { x: 100, y: 100, width: 220, height: 300 },
          agent: {
            role: "read",
            persona: "Review the resources",
            enabled: true,
            ...(missingModel ? { model: { profileId: "unavailable-model" } } : {}),
          },
          idempotencyKey: key(),
        },
      })
    ).json()
  ).node as Node;
  await page.goto("/");
  await page.getByLabel(/^(切换画布|Switch canvas)$/).click();
  await page.getByRole("button", { name: title, exact: true }).click();
  return { a, board };
}
async function patch(request: APIRequestContext, node: Node, data: object) {
  const fresh = (await (await request.get(`${API_URL}/api/v2/nodes/${node.id}/content`)).json())
    .node;
  const response = await request.patch(`${API_URL}/api/v2/nodes/${node.id}`, {
    data: { ...data, expectedRevision: fresh.revision, idempotencyKey: key() },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).node as Node;
}
test("resource status survives refresh; explicit retry, stop and later changes use durable state", async ({
  page,
  request,
}) => {
  const { a, board } = await scene(page, request, true);
  const r = (
    await (
      await request.post(`${API_URL}/api/v2/nodes`, {
        data: {
          kind: "text",
          parentId: board.id,
          title: "Evidence",
          text: "original",
          position: { x: 500, y: 100, width: 220, height: 200 },
          idempotencyKey: key(),
        },
      })
    ).json()
  ).node as Node;
  expect(
    (
      await request.post(`${API_URL}/api/v2/links`, {
        data: { fromId: a.id, toId: r.id, idempotencyKey: key() },
      })
    ).ok(),
  ).toBe(true);
  await patch(request, r, { summary: "first revision" });
  await page.locator(`[data-node-id="${a.id}"]`).dblclick();
  const status = page.locator(".agent-inspector .resource-response");
  await expect(status).toContainText("资源响应等待处理");
  await expect(status).toContainText("等待模型配置", { timeout: 25_000 });
  await page.reload();
  await page.locator(`[data-node-id="${a.id}"]`).dblclick();
  await expect(status).toContainText("等待模型配置");
  const response = page.waitForResponse(
    (res) => res.url().endsWith("/resource-response/retry") && res.request().method() === "POST",
  );
  await status.getByRole("button", { name: "重试资源响应" }).click();
  expect((await response).ok()).toBe(true);
  await expect(status).toContainText("等待模型配置");
  const feed = async () => (await request.get(`${API_URL}/api/v2/canvas-agents/${a.id}`)).json();
  expect(
    (await feed()).events.filter((e: any) => e.data.category === "resource_response"),
  ).toHaveLength(1);
  expect((await request.post(`${API_URL}/api/v2/canvas-agents/${a.id}/stop`)).ok()).toBe(true);
  await patch(request, a, { agent: { ...a.agent!, model: null } });
  await expect(status).toContainText("旧资源响应已停止");
  expect((await feed()).events.filter((e: any) => e.kind === "trigger")).toHaveLength(0);
  await expect(status.getByRole("button")).toHaveCount(0);
  await patch(request, r, { summary: "new evidence" });
  await expect(status).toContainText("资源响应等待处理");
  await expect(status).toContainText("Agent 已读取", { timeout: 25_000 });
  expect((await feed()).events.filter((e: any) => e.kind === "trigger")).toHaveLength(1);
});

test("resource response reasons and retry control fit a narrow panel in both languages", async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 850 });
  const { a } = await scene(page, request);
  let resourceResponse: ResourceResponseStatus = {
    state: "blocked",
    revision: "14",
    sourceSeq: "7",
    nextDueAt: null,
    reason: "activation_limit",
    runId: null,
    canRetry: true,
  };
  await page.route(`**/api/v2/canvas-agents/${a.id}*`, async (route) => {
    if (new URL(route.request().url()).pathname !== `/api/v2/canvas-agents/${a.id}`)
      return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), resourceResponse } });
  });
  for (const language of ["zh-CN", "en"]) {
    await page.evaluate((language) => localStorage.setItem("intrica:language", language), language);
    await page.reload();
    await page.locator(`[data-node-id="${a.id}"]`).dblclick();
    const handle = await page
      .getByRole("separator", { name: /调整侧栏宽度|Resize sidebar/ })
      .boundingBox();
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + 150);
    await page.mouse.down();
    await page.mouse.move(1280 - 320, handle!.y + 150);
    await page.mouse.up();
    const status = page.locator(".agent-inspector .resource-response");
    for (const reason of [
      "activation_limit",
      "model_not_configured",
      "source_missing",
      "queue_full",
      "retry_pending",
      "legacy_configuration",
    ] as const) {
      resourceResponse = { ...resourceResponse, reason };
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      const phrases =
        language === "zh-CN"
          ? {
              activation_limit: "自动协作上限",
              model_not_configured: "模型配置",
              source_missing: "来源运行不可用",
              queue_full: "队列空位",
              retry_pending: "暂时无法启动",
              legacy_configuration: "升级前",
            }
          : {
              activation_limit: "collaboration limit",
              model_not_configured: "model configuration",
              source_missing: "source run is unavailable",
              queue_full: "queue capacity",
              retry_pending: "could not start",
              legacy_configuration: "before the upgrade",
            };
      await expect(status).toContainText(phrases[reason]);
      await expect(status.getByRole("button")).toBeVisible();
      const panel = (await page.locator(".agent-inspector").boundingBox())!;
      const banner = (await status.boundingBox())!;
      expect(banner.x).toBeGreaterThanOrEqual(panel.x);
      expect(banner.x + banner.width).toBeLessThanOrEqual(panel.x + panel.width);
      expect(await status.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await status.getByRole("button").focus();
      await expect(status.getByRole("button")).toBeFocused();
    }
    await page
      .locator(".agent-inspector")
      .screenshot({ path: info.outputPath(`resource-response-${language}.png`) });
  }
});
