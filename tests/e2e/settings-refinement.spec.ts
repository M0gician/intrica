import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

test("canvas menu and sidebar open settings with continuous usage navigation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "切换画布", exact: true }).click();
  await page.locator(".canvas-menu").getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("main", { name: "设置", exact: true });
  await settings.getByRole("button", { name: "运行与用量", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "运行与用量", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "通用", exact: true }).click();
  await expect(settings.getByLabel("语言", { exact: true })).toBeVisible();
  const back = settings.getByRole("button", { name: "返回画布", exact: true });
  expect((await back.boundingBox())!.width).toBeLessThanOrEqual(40);
  await back.click();
  await expect
    .poll(() =>
      page
        .locator(".canvas-viewport")
        .evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
  await page.locator(".workspace-panel").getByRole("button", { name: "设置", exact: true }).click();
  await expect(settings).toBeVisible();
});

test("shortcut remapping is persistent, detects conflicts and controls the canvas", async ({
  page,
}) => {
  await page.goto("/#settings/shortcuts");
  const settings = page.getByRole("main", { name: "设置", exact: true });
  const open = settings.getByRole("button", { name: "修改快捷键：打开设置", exact: true });
  await open.click();
  await open.press("Control+a");
  await expect(settings.getByRole("alert")).toContainText("选择当前层");
  await open.press("Control+Shift+s");
  await expect(open).toContainText("Shift s");
  const zoom = settings.getByRole("button", { name: "修改快捷键：放大画布", exact: true });
  await zoom.click();
  await zoom.press("Shift+i");
  await settings.getByRole("button", { name: "返回画布", exact: true }).click();
  const viewport = page.locator(".canvas-viewport");
  await viewport.focus();
  const before = await page.locator(".zoom-value").innerText();
  await viewport.press("Shift+i");
  await expect(page.locator(".zoom-value")).not.toHaveText(before);
  await page.keyboard.press("Control+Shift+s");
  await expect(settings).toBeVisible();
  await page.reload();
  await expect(open).toContainText("Shift s");
  await expect(zoom).toContainText("Shift i");
  await settings.getByRole("button", { name: "恢复快捷键：打开设置", exact: true }).click();
  await expect(open).not.toContainText("Shift s");
});

test("endpoint groups contain model rows and editor actions have separate space", async ({
  page,
  request,
}) => {
  const name = `Hierarchy ${randomUUID()}`;
  const response = await request.post(`${API_URL}/api/v2/model-endpoints`, {
    data: { name, baseUrl: "http://127.0.0.1:9999/v1", apiKey: "test-only-key" },
  });
  expect(response.ok()).toBe(true);
  const endpoint = (await response.json()).endpoints.find(
    (item: { name: string }) => item.name === name,
  );
  try {
    const created = await request.post(`${API_URL}/api/v2/workspace/models`, {
      data: {
        endpointId: endpoint.id,
        name: "Nested model",
        provider: "openai",
        modelId: "nested-model",
        api: "openai-completions",
        contextWindow: 128000,
        maxOutputTokens: 4096,
        reasoning: false,
        supportsVision: false,
        thinkingLevel: "off",
      },
    });
    expect(created.ok()).toBe(true);
    await page.goto("/#settings/models");
    const group = page.locator(".settings-endpoint").filter({ hasText: name });
    await expect(group.locator(".settings-model-list")).toContainText("Nested model");
    const hierarchy = await group.evaluate((element) => {
      const header = element.querySelector("header")!.getBoundingClientRect();
      const row = element.querySelector("li")!.getBoundingClientRect();
      return { inset: row.x - header.x, below: row.y >= header.bottom };
    });
    expect(hierarchy.inset).toBeGreaterThan(20);
    expect(hierarchy.below).toBe(true);
    await group.getByRole("button", { name: `管理端点：${name}`, exact: true }).click();
    await page.getByRole("button", { name: "编辑 API 端点", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "编辑 API 端点", exact: true });
    await expect(
      editor.getByRole("checkbox", { name: "无需 API 密钥", exact: true }),
    ).not.toBeChecked();
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 720 });
      const keyOption = editor.locator(".endpoint-key-option");
      const actions = editor.locator(".settings-form-actions");
      const inputBounds = (await keyOption.boundingBox())!,
        buttons = (await actions.boundingBox())!;
      expect(buttons.y - inputBounds.y - inputBounds.height).toBeGreaterThanOrEqual(20);
      expect(buttons.x + buttons.width).toBeLessThanOrEqual(width);
      expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await page.screenshot({ path: test.info().outputPath(`endpoint-editor-${width}.png`) });
    }
  } finally {
    await request.delete(
      `${API_URL}/api/v2/model-endpoints/${endpoint.id}?expectedRevision=${endpoint.revision}`,
    );
  }
});
