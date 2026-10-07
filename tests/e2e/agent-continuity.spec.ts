import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

const api = API_URL;
async function setup(page: any, request: any) {
  const board = (
    await (
      await request.post(`${api}/api/v2/canvases`, {
        data: { title: `会话连续性 ${randomUUID().slice(0, 5)}`, idempotencyKey: randomUUID() },
      })
    ).json()
  ).node;
  const create = async (title: string, x: number, kind = "agent") =>
    (
      await (
        await request.post(`${api}/api/v2/nodes`, {
          data: {
            kind,
            parentId: board.id,
            title,
            ...(kind === "agent"
              ? { agent: { persona: "核查资料", role: "read", enabled: false } }
              : { text: "证据正文" }),
            position: { x, y: 160, width: 220, height: 300 },
            idempotencyKey: randomUUID(),
          },
        })
      ).json()
    ).node;
  const a = await create("周宁", 120),
    b = await create("林舟", 460),
    resource = await create("未连接资料", 800, "text");
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: board.title, exact: true }).click();
  return { board, a, b, resource };
}
test("Agent 草稿按元素保留、刷新恢复；失败保留，发送中输入的新内容不被清空", async ({
  page,
  request,
}) => {
  const { a, b } = await setup(page, request);
  const card = (id: string) => page.locator(`[data-node-id="${id}"]`);
  await card(a.id).dblclick();
  await page.getByLabel("Agent 任务").fill("周宁的未发送草稿");
  await card(b.id).click();
  await expect(page.getByLabel("Agent 任务")).toHaveValue("");
  await page.getByLabel("Agent 任务").fill("林舟的未发送草稿");
  await card(a.id).click();
  await expect(page.getByLabel("Agent 任务")).toHaveValue("周宁的未发送草稿");
  await page.reload();
  await card(a.id).dblclick();
  await expect(page.getByLabel("Agent 任务")).toHaveValue("周宁的未发送草稿");
  await page.route(`**/api/v2/canvas-agents/${a.id}/run`, (r) =>
    r.fulfill({ status: 500, json: { error: { code: "INTERNAL", message: "测试发送失败" } } }),
  );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("服务暂时不可用，请稍后重试。");
  await expect(page.getByLabel("Agent 任务")).toHaveValue("周宁的未发送草稿");
  await page.unroute(`**/api/v2/canvas-agents/${a.id}/run`);
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  await page.route(`**/api/v2/canvas-agents/${a.id}/run`, async (r) => {
    began();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await r.continue();
  });
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await started;
  await page.getByLabel("Agent 任务").fill("发送期间的新草稿");
  await expect(page.locator(".agent-event-user")).toContainText("周宁的未发送草稿");
  await expect(page.getByLabel("Agent 任务")).toHaveValue("发送期间的新草稿");
  await card(b.id).click();
  await expect(page.getByLabel("Agent 任务")).toHaveValue("林舟的未发送草稿");
  await card(a.id).click();
  await expect(page.getByLabel("Agent 任务")).toHaveValue("发送期间的新草稿");
});
test("权限卡片位于相关会话中，通知直接定位；上下文和压缩选择可见", async ({ page, request }) => {
  const { a, resource, board } = await setup(page, request);
  const permission = {
    toolCallId: null,
    version: 1,
    decidedBy: null,
    decisionReason: null,
    routeReason: "user",
    expiresAt: "2099-01-01T00:00:00Z",
    reviewDueAt: null,
    executionState: null,
    kind: "resource",
    scope: "persistent",
    summary: { resourceIds: [resource.id], mode: "read" },
    allowedActions: ["approve", "deny"],
    id: "access-fixture",
    agentId: a.id,
    nodeId: resource.id,
    mode: "read",
    reason: "需要核对原始资料",
    status: "pending",
    reviewerId: null,
    decision: null,
  };
  const events: any[] = [
    { seq: 1, agentId: a.id, kind: "user", data: { text: "请查阅这份资料" } },
    { seq: 2, agentId: a.id, kind: "assistant", data: { text: "这里需要先获得授权。" } },
    {
      seq: 3,
      agentId: a.id,
      kind: "access",
      data: { requestId: permission.id, nodeId: resource.id, reason: permission.reason },
    },
    ...Array.from({ length: 12 }, (_, i) => ({
      seq: i + 4,
      agentId: a.id,
      kind: "assistant",
      data: { text: "后续会话占位。".repeat(60) },
    })),
  ];
  const snapshot = await (await request.get(`${api}/api/v2/bootstrap`)).json();
  await page.route(`**/api/v2/agent-access?canvasId=${board.id}*`, (r) =>
    r.fulfill({
      json: {
        graphRevision: snapshot.graphRevision,
        requests: [permission],
        total: 1,
        nextCursor: null,
      },
    }),
  );
  await page.route(`**/api/v2/canvas-agents/${a.id}*`, (r) =>
    r.fulfill({
      json: {
        events,
        requests: [permission],
        running: false,
        context: {
          tokens: 32000,
          contextWindow: 65536,
          safeLimit: 43008,
          source: "usage",
          windowSource: "configured",
          modelId: "test",
          state: "ready",
          compactions: 1,
        },
      },
    }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.locator(".agent-inbox > summary").click();
  await page
    .locator(".agent-inbox-list")
    .getByRole("button", { name: /需要核对原始资料/ })
    .click();
  const access = page.locator('[data-access-id="access-fixture"]');
  await expect(access).toBeFocused();
  await expect(access).toBeInViewport();
  expect(await access.evaluate((el) => Boolean(el.closest(".agent-event-access")))).toBe(true);
  await expect(page.locator(".agent-settings-disclosure .agent-access-card")).toHaveCount(0);
  await page.getByRole("button", { name: /上下文用量/ }).hover();
  await expect(page.getByRole("tooltip")).toContainText("32,000 / 65,536");
  await expect(page.getByRole("tooltip")).toContainText("安全上限");
  await page.screenshot({ path: test.info().outputPath("pending-permission.png") });
  await page.route("**/api/v2/agent-access/access-fixture", (r) => {
    permission.status = "approved";
    events.push({
      seq: 30,
      agentId: a.id,
      kind: "access",
      data: { requestId: permission.id, decision: "approve" },
    });
    return r.fulfill({ json: permission });
  });
  await access.getByRole("button", { name: "批准授权" }).click();
  await expect(access).toContainText("已批准");
  await page.getByRole("button", { name: "Agent 能力与设置" }).click();
  await expect(page.getByLabel("压缩前保存关键资料")).toBeChecked();
  await page.screenshot({ path: test.info().outputPath("permissions-context.png") });
});
