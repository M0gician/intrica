import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

test("canvas and settings icons share an origin, and menus use compact anchored controls", async ({
  page,
}) => {
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    const canvas = page.getByRole("button", { name: "切换画布", exact: true });
    await expect(canvas).toBeVisible();
    const icon = (await canvas.locator(":scope > svg").boundingBox())!;
    const geometry = await canvas.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const content = Array.from(element.children).filter(
        (child) => child.getBoundingClientRect().width > 0,
      );
      const end = content.at(-1)!.getBoundingClientRect();
      return {
        width: bounds.width,
        trailingSpace: bounds.right - end.right,
        padding: Number.parseFloat(getComputedStyle(element).paddingRight),
      };
    });
    expect(geometry.width).toBeLessThanOrEqual(260);
    expect(geometry.trailingSpace).toBeCloseTo(geometry.padding, 1);
    await page.keyboard.press("Control+,");
    const settings = page.getByRole("main", { name: "设置", exact: true });
    const back = settings.getByRole("button", { name: "返回画布", exact: true });
    const home = (await back.locator("svg").boundingBox())!;
    expect(home).toEqual(icon);
    await settings.getByRole("button", { name: "服务器连接", exact: true }).click();
    const more = settings.getByRole("button", { name: /^管理连接：/ }).first();
    const button = (await more.boundingBox())!;
    const dots = (await more.locator("svg").boundingBox())!;
    expect(button.width).toBe(32);
    expect(button.height).toBe(32);
    expect(dots.width).toBe(16);
    expect(dots.height).toBe(16);
    expect(dots.x + dots.width / 2).toBeCloseTo(button.x + button.width / 2, 1);
    expect(dots.y + dots.height / 2).toBeCloseTo(button.y + button.height / 2, 1);
    await more.click();
    await expect(settings.getByRole("button", { name: "连接详情", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`connection-menu-${width}.png`) });
    await page.keyboard.press("Escape");
    await settings.getByRole("button", { name: "通用", exact: true }).click();
    const language = settings.getByLabel("语言", { exact: true });
    await language.click();
    const english = language.getByRole("option", { name: "English", exact: true });
    await expect(english).toBeVisible();
    expect(
      await language.evaluate(
        (element) => getComputedStyle(element, "::picker(select)").borderRadius,
      ),
    ).toBe("14px");
    const option = (await english.boundingBox())!;
    expect(option.x).toBeGreaterThanOrEqual(0);
    expect(option.x + option.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: test.info().outputPath(`settings-choice-${width}.png`) });
    await english.click();
    await expect(page.getByLabel("Language", { exact: true })).toHaveValue("en");
    await page.getByLabel("Language", { exact: true }).selectOption("zh-CN");
  }
});

test("model discovery loads automatically, retries explicitly and isolates changed protocols", async ({
  page,
  request,
}) => {
  const calls: Array<{ url: string; authorization: string; anthropicKey: string }> = [];
  let status = 401;
  let holdOpenAi = false;
  let releaseOld: (() => void) | undefined;
  let oldCancelled = false;
  const server = createServer((incoming, response) => {
    const anthropicKey = String(incoming.headers["x-api-key"] ?? "");
    calls.push({
      url: incoming.url!,
      authorization: incoming.headers.authorization ?? "",
      anthropicKey,
    });
    const data = {
      data: [
        {
          id: anthropicKey ? "messages-model" : "chat-model",
          reasoning_efforts: ["none", "low", "high", "max"],
        },
      ],
    };
    if (holdOpenAi && !anthropicKey) {
      releaseOld = () =>
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(data));
      response.on("close", () => {
        oldCancelled = !response.writableEnded;
      });
      return;
    }
    response
      .writeHead(incoming.url === "/v1/models" ? status : 404, {
        "content-type": "application/json",
      })
      .end(
        JSON.stringify(
          status === 200 ? data : { error: { message: "discovery-test-key rejected" } },
        ),
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const name = `Discovery ${randomUUID()}`;
  const created = await request.post(`${API_URL}/api/v2/model-endpoints`, {
    data: { name, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "discovery-test-key" },
  });
  expect(created.ok()).toBe(true);
  const endpoint = (await created.json()).endpoints.find(
    (item: { name: string }) => item.name === name,
  );
  try {
    await page.goto("/#settings/models");
    const group = page.locator(".settings-endpoint").filter({ hasText: name });
    await group.getByRole("button", { name: "添加模型", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "添加模型", exact: true });
    const models = editor.getByLabel("模型", { exact: true });
    const refresh = editor.getByRole("button", { name: "刷新模型", exact: true });
    await expect(editor.getByRole("alert")).toContainText("HTTP 401");
    expect(calls).toEqual([
      { url: "/v1/models", authorization: "Bearer discovery-test-key", anthropicKey: "" },
    ]);
    await editor.getByLabel("显示名称", { exact: true }).fill("Manual draft");
    await editor.getByLabel("模型 ID", { exact: true }).fill("manual-model");
    status = 500;
    await refresh.click();
    await expect(editor.getByRole("alert")).toContainText("HTTP 500");
    await expect(editor.getByRole("alert")).not.toContainText("discovery-test-key");
    status = 200;
    await refresh.click();
    await expect(models).toContainText("chat-model");
    await expect(editor.getByLabel("显示名称", { exact: true })).toHaveValue("Manual draft");
    await expect(editor.getByLabel("模型 ID", { exact: true })).toHaveValue("manual-model");
    expect(calls).toHaveLength(3);
    holdOpenAi = true;
    await refresh.click();
    await expect.poll(() => calls.length).toBe(4);
    await expect(editor.getByLabel("显示名称", { exact: true })).toBeEnabled();
    await editor.getByLabel("协议", { exact: true }).selectOption("anthropic-messages");
    await expect(models).toContainText("messages-model");
    expect(calls.at(-1)?.anthropicKey).toBe("discovery-test-key");
    await expect.poll(() => oldCancelled).toBe(true);
    releaseOld!();
    releaseOld = undefined;
    await expect(models).not.toContainText("chat-model");
    await models.selectOption("messages-model");
    const effort = editor.getByRole("slider", { name: "推理强度", exact: true });
    await effort.press("End");
    await expect(effort).toHaveAttribute("aria-valuetext", "最高");
    await effort.press("ArrowLeft");
    await expect(effort).toHaveAttribute("aria-valuetext", "高");
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const discovery = (await editor.locator(".model-discovery-field").boundingBox())!;
      const fields = (await editor
        .getByLabel("显示名称", { exact: true })
        .locator("..")
        .boundingBox())!;
      expect(fields.y - discovery.y - discovery.height).toBeGreaterThanOrEqual(18);
      expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await page.screenshot({ path: test.info().outputPath(`model-editor-${width}.png`) });
    }
    const violations = (
      await new AxeBuilder({ page }).include("dialog").analyze()
    ).violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""));
    expect(violations).toEqual([]);
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await expect(editor).toHaveCount(0);
    const directory = await (await request.get(`${API_URL}/api/v2/workspace/models`)).json();
    expect(
      directory.profiles.find(
        (profile: { endpointId: string }) => profile.endpointId === endpoint.id,
      ),
    ).toMatchObject({
      modelId: "messages-model",
      api: "anthropic-messages",
      thinkingLevel: "high",
    });
  } finally {
    releaseOld?.();
    await request.delete(
      `${API_URL}/api/v2/model-endpoints/${endpoint.id}?expectedRevision=${endpoint.revision}`,
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
