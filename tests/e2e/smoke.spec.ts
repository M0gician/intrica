import { randomUUID } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

test("独立画布完成编辑、生成审阅、刷新与删除撤销", async ({ page, request }) => {
  const created = await request.post(`${API_URL}/api/v2/canvases`, {
    data: { title: "完整工作流", idempotencyKey: randomUUID() },
  });
  expect(created.ok()).toBe(true);
  const board = (await created.json()).node;
  const serverId = (await (await request.get(`${API_URL}/api/v2/server`)).json()).id;
  await page.addInitScript(
    ({ id, serverId }) => localStorage.setItem(`intrica:server:${serverId}:intrica:canvas`, id),
    { id: board.id, serverId },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "新建节点", exact: true }).click();
  await page.getByRole("menuitem", { name: "文字", exact: true }).click();
  await page.getByRole("textbox", { name: "节点标题", exact: true }).fill("竞品假设");
  const sourceToggle = page.getByRole("button", { name: "查看源码", exact: true });
  if (await sourceToggle.isVisible()) await sourceToggle.click();
  await page
    .getByRole("textbox", { name: "编辑节点正文", exact: true })
    .fill("竞品将在 30 天内免费开放核心功能。");
  await expect(page.locator(".save-status")).toHaveText("已保存");
  await page.getByRole("button", { name: "关闭详情侧栏", exact: true }).click();
  const source = page.getByRole("article", { name: "文字：竞品假设", exact: true });
  await expect(source).toContainText("30 天内免费开放");
  await page.getByRole("button", { name: "扩展：当前层生成平行节点", exact: true }).click();
  await page
    .getByRole("group", { name: "扩展确认" })
    .getByRole("button", { name: "开始生成" })
    .click();
  const pending = page.getByRole("group", { name: "扩展任务：未提交", exact: true });
  await expect(pending).toBeVisible();
  await pending.getByRole("button", { name: "接受全部", exact: true }).click();
  const cards = page.locator(".node-card:not([data-candidate])");
  await expect.poll(() => cards.count()).toBeGreaterThan(1);
  const count = await cards.count();
  await page.reload();
  await expect(cards).toHaveCount(count);
  await expect(source).toContainText("30 天内免费开放");
  await source.click();
  await page
    .getByRole("toolbar", { name: "节点操作", exact: true })
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await expect(source).toHaveCount(0);
  await page.getByRole("button", { name: "撤销", exact: true }).last().click();
  await expect(source).toBeVisible();
  await expect(cards).toHaveCount(count);
  await expect(source).toContainText("30 天内免费开放");
  const violations = (await new AxeBuilder({ page }).analyze()).violations.filter((v) =>
    ["critical", "serious"].includes(v.impact ?? ""),
  );
  expect(violations).toEqual([]);
});
