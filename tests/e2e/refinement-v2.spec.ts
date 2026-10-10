import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

const api = `${API_URL}/api/v2`;
async function create(request: any, extra: any = {}) {
  const response = await request.post(`${api}/nodes`, {
    data: {
      kind: "text",
      parentId: "canvas-e2e",
      title: "连续编辑验证",
      text: "最初正文",
      position: { x: 80, y: 150, width: 240, height: 160 },
      idempotencyKey: randomUUID(),
      ...extra,
    },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).node;
}
test("连续保存使用最新版本，切换正文模式位置稳定且顶部留白紧凑", async ({ page, request }) => {
  const node = await create(request);
  await page.goto("/");
  await page.locator(`[data-node-id="${node.id}"]`).dblclick();
  await page.getByRole("button", { name: "查看源码", exact: true }).click();
  const editor = page.getByLabel("编辑节点正文");
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let blocked = false;
  await page.route(`**/api/v2/nodes/${node.id}`, async (route) => {
    if (route.request().method() === "PATCH" && !blocked) {
      blocked = true;
      await gate;
    }
    await route.continue();
  });
  await editor.fill("第一段修改");
  await expect.poll(() => blocked).toBe(true);
  await editor.fill("第二段继续输入");
  release();
  await expect(page.locator(".save-status")).toHaveText("已保存");
  await editor.fill("第三段最终保存");
  await expect(page.locator(".save-status")).toHaveText("已保存");
  const persisted = await (await request.get(`${api}/nodes/${node.id}/content`)).json();
  expect(persisted.node.text).toBe("第三段最终保存");
  expect(persisted.node.revision).toBeGreaterThanOrEqual(3);
  const metrics = await page.locator(".source-editor").evaluate((el) => ({
    top: el.querySelector(".cm-line")!.getBoundingClientRect().top - el.getBoundingClientRect().top,
    gutter: Math.abs(
      el.querySelector(".cm-line")!.getBoundingClientRect().top -
        Array.from(el.querySelectorAll(".cm-gutterElement"))
          .find((n) => (n as HTMLElement).style.visibility !== "hidden")!
          .getBoundingClientRect().top,
    ),
  }));
  expect(metrics.top).toBeLessThanOrEqual(8);
  expect(metrics.gutter).toBeLessThan(1);
  const toggle = page.getByRole("button", { name: "预览正文", exact: true });
  const before = (await toggle.boundingBox())!;
  const area = (await page.locator(".document-editor").boundingBox())!;
  await toggle.click();
  const after = (await page.getByRole("button", { name: "查看源码", exact: true }).boundingBox())!;
  expect(Math.abs(before.x - after.x)).toBeLessThan(1);
  expect(Math.abs(before.y - after.y)).toBeLessThan(1);
  expect(
    Math.abs((await page.locator(".document-editor").boundingBox())!.height - area.height),
  ).toBeLessThan(2);
  await page.screenshot({ path: test.info().outputPath("editor-stable.png") });
});
test("Agent 肖像和模型控件完整，团队成员只出现在内部空间", async ({ page, request }) => {
  const manager = await create(request, {
    kind: "agent",
    title: "团队管理者",
    agent: { persona: "管理团队", role: "admin", enabled: false },
    text: undefined,
    position: { x: 400, y: 150, width: 240, height: 320 },
  });
  const member = await create(request, {
    kind: "agent",
    parentId: manager.id,
    title: "测试工程师",
    agent: { persona: "验证结果", role: "write", enabled: false },
    text: undefined,
    position: { x: 24, y: 72, width: 240, height: 320 },
  });
  await page.goto("/");
  const card = page.locator(`[data-node-id="${manager.id}"]`);
  await card.dblclick();
  await expect(page.getByLabel("重新生成肖像").locator("svg")).toBeVisible();
  await expect(page.locator(".agent-manager-field")).toHaveCSS("font-size", "11px");
  await expect(page.getByRole("button", { name: "Agent 模型", exact: true })).toContainText(
    "acceptance",
  );
  await expect(page.locator(".context-usage-percent")).toBeVisible();
  await expect(page.locator(`.canvas-world > [data-node-id="${member.id}"]`)).toHaveCount(0);
  await page.getByRole("button", { name: "进入内部", exact: true }).first().click();
  const overlay = page.getByRole("region", { name: /临时内部空间/ });
  await expect(overlay.locator(`[data-node-id="${member.id}"]`)).toBeVisible();
  const bounds = (await overlay.boundingBox())!;
  const inspector = (await page.locator(".workspace-panel").boundingBox())!;
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(inspector.x);
  await page.screenshot({ path: test.info().outputPath("agent-team.png") });
});
test("裸域名自动显示网页卡片，禁止嵌入的网站使用明确预览而非空白 iframe", async ({
  page,
  request,
}) => {
  await page.route("**/api/v2/workspace/web-title?*", (route) =>
    route.fulfill({ json: { title: "Google", description: "网页摘要预览", imageUrl: null } }),
  );
  const node = await create(request, {
    title: "www.google.com",
    text: "www.google.com",
    position: { x: 80, y: 450, width: 240, height: 180 },
  });
  await page.goto("/");
  const card = page.locator(`[data-node-id="${node.id}"]`);
  await expect(card).toHaveClass(/bookmark-card/);
  await expect(card.locator("iframe")).toHaveCount(0);
  await expect(card).toContainText("网页摘要预览");
  await expect(card).toContainText("网站摘要");
  await page.screenshot({ path: test.info().outputPath("website-preview.png") });
});
