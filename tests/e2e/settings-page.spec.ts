import { randomUUID } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

test("settings supports search, field links, keyboard entry and browser navigation", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "切换画布", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(切换画布|Switch canvas)$/ })).toBeVisible();
  await page.keyboard.press("Control+,");
  const settings = page.getByRole("main", { name: "设置", exact: true });
  await expect(settings).toBeVisible();
  await settings.getByRole("searchbox", { name: "搜索设置" }).fill("language");
  await settings.getByRole("button", { name: "语言", exact: true }).click();
  await expect(settings.getByLabel("语言", { exact: true })).toBeFocused();
  await expect(page).toHaveURL(/#settings\/general\/language$/);
  await settings.getByRole("searchbox").fill("");
  await settings.getByRole("button", { name: "运行限制", exact: true }).click();
  await expect(settings.getByLabel("会话并发上限", { exact: true })).toBeVisible();
  await page.goBack();
  await expect(settings.getByLabel("语言", { exact: true })).toBeVisible();
  await page.goForward();
  await expect(settings.getByLabel("会话并发上限", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "返回画布", exact: true }).click();
  await expect(page.locator(".canvas-viewport")).toBeVisible();
  await page.keyboard.press("Meta+,");
  await expect(settings.getByLabel("会话并发上限", { exact: true })).toBeVisible();
});

test("browser navigation protects an execution draft", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^(切换画布|Switch canvas)$/ })).toBeVisible();
  await page.keyboard.press("Control+,");
  const settings = page.getByRole("main", { name: "设置", exact: true });
  await settings.getByRole("button", { name: "运行限制", exact: true }).click();
  const limit = settings.getByLabel("会话并发上限", { exact: true });
  await expect(limit).toBeVisible();
  const original = await limit.inputValue();
  await limit.fill(original === "17" ? "18" : "17");
  await page.goBack();
  const decision = page.getByRole("alertdialog", { name: "有未保存的修改", exact: true });
  await expect(decision).toBeVisible();
  await decision.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(limit).toHaveValue(original === "17" ? "18" : "17");
  await expect(page).toHaveURL(/#settings\/execution$/);
  await page.goBack();
  await expect(decision).toBeVisible();
  await decision.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(settings.getByLabel("语言", { exact: true })).toBeVisible();
  await page.goForward();
  await expect(limit).toHaveValue(original);
});

test("settings preserves the canvas draft and pauses hidden agent reads", async ({
  page,
  request,
}) => {
  const title = `Settings state ${randomUUID()}`;
  const canvas = (
    await (
      await request.post(`${API_URL}/api/v2/canvases`, {
        data: { title, idempotencyKey: randomUUID() },
      })
    ).json()
  ).node;
  const agent = (
    await (
      await request.post(`${API_URL}/api/v2/nodes`, {
        data: {
          kind: "agent",
          parentId: canvas.id,
          title: "设置验证 Agent",
          agent: { role: "read", enabled: false, persona: "核对画布" },
          position: { x: 180, y: 180, width: 240, height: 180 },
          idempotencyKey: randomUUID(),
        },
      })
    ).json()
  ).node;
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "切换画布", exact: true }).click();
    await page.getByRole("button", { name: title, exact: true }).click();
    await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
    const draft = page.getByLabel("Agent 任务", { exact: true });
    await draft.fill("保留尚未发送的设置验证草稿");
    const transform = await page.locator(".canvas-world").getAttribute("style");
    await expect(page.getByRole("button", { name: /^(切换画布|Switch canvas)$/ })).toBeVisible();
    await page.keyboard.press("Control+,");
    await expect(page.getByRole("main", { name: "设置", exact: true })).toBeVisible();
    await page.waitForTimeout(150);
    let reads = 0;
    page.on("request", (request) => {
      if (
        request.method() === "GET" &&
        new URL(request.url()).pathname === `/api/v2/canvas-agents/${agent.id}`
      )
        reads++;
    });
    const started = await request.post(`${API_URL}/api/v2/canvas-agents/${agent.id}/run`, {
      data: { message: "核对画布并汇报", idempotencyKey: randomUUID() },
    });
    expect(started.ok()).toBe(true);
    await expect
      .poll(
        async () =>
          (await (await request.get(`${API_URL}/api/v2/canvas-agents/${agent.id}`)).json())
            .runState,
      )
      .toBe("succeeded");
    await page.waitForTimeout(300);
    const hiddenReads = reads;
    await page.getByRole("button", { name: "返回画布", exact: true }).click();
    await expect(draft).toBeVisible();
    const restoredDraft = await draft.inputValue();
    await test.info().attach("settings-state.json", {
      body: JSON.stringify({
        hiddenReads,
        draftPreserved: restoredDraft === "保留尚未发送的设置验证草稿",
        viewportPreserved:
          (await page.locator(".canvas-world").getAttribute("style")) === transform,
      }),
      contentType: "application/json",
    });
    expect(hiddenReads).toBe(0);
    expect(restoredDraft).toBe("保留尚未发送的设置验证草稿");
    await expect(page.locator(".canvas-world")).toHaveAttribute("style", transform!);
    await expect(page.getByLabel("Agent 共享会话")).toContainText("模拟会话第 1 轮");
    await page.getByRole("button", { name: "模型会话", exact: true }).click();
    const question = page.getByLabel("模型问题", { exact: true });
    await question.fill("保留未发送的模型会话草稿");
    await expect(page.getByRole("button", { name: /^(切换画布|Switch canvas)$/ })).toBeVisible();
    await page.keyboard.press("Control+,");
    await page.getByRole("button", { name: "返回画布", exact: true }).click();
    await expect(question).toHaveValue("保留未发送的模型会话草稿");
  } finally {
    await request.delete(`${API_URL}/api/v2/canvases/${canvas.id}`);
  }
});

test("English settings fit narrow screens and expose accessible names", async ({ page }) => {
  await page.goto("/#settings/general/language");
  await page.getByLabel("语言", { exact: true }).selectOption("en");
  const settings = page.getByRole("main", { name: "Settings", exact: true });
  await expect(settings.getByRole("status")).toHaveText("Saved");
  await page.setViewportSize({ width: 320, height: 640 });
  expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  const violations = (
    await new AxeBuilder({ page }).include(".settings-page").analyze()
  ).violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""));
  expect(violations).toEqual([]);
  await settings.getByRole("button", { name: "Runs and usage", exact: true }).click();
  await expect(
    settings.getByRole("heading", { name: "Runs and usage", exact: true }),
  ).toBeVisible();
  expect(
    await page
      .locator(".settings-page")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.getByRole("button", { name: "Back to canvas", exact: true }).click();
  const boxes = await page.locator(".top-bar button").evaluateAll((buttons) =>
    buttons
      .filter((button) => button.getClientRects().length > 0)
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          name: button.getAttribute("aria-label"),
          x: rect.x,
          y: rect.y,
          right: rect.right,
          bottom: rect.bottom,
        };
      }),
  );
  for (const [index, box] of boxes.entries()) {
    expect(box.x, box.name ?? "toolbar button").toBeGreaterThanOrEqual(0);
    expect(box.right, box.name ?? "toolbar button").toBeLessThanOrEqual(320);
    for (const other of boxes.slice(index + 1)) {
      const overlap =
        Math.min(box.right, other.right) - Math.max(box.x, other.x) > 1 &&
        Math.min(box.bottom, other.bottom) - Math.max(box.y, other.y) > 1;
      expect(overlap, `${box.name} overlaps ${other.name}`).toBe(false);
    }
  }
});
