import { createServer, type Server } from "node:http";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

test.use({ actionTimeout: 10000 });
let server: Server, endpoint: string;
let fail = false;
const calls: any[] = [];
const authorizations: string[] = [];
const api = API_URL;
test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.method === "GET") {
      authorizations.push(req.headers.authorization ?? "");
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          data: [{ id: "settings-research", reasoning_efforts: ["none", "low", "high"] }],
        }),
      );
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(input);
    if (fail) {
      res
        .writeHead(401, { "content-type": "application/json" })
        .end('{"error":{"message":"fixture rejected"}}');
      return;
    }
    res
      .writeHead(200, { "content-type": "text/event-stream" })
      .end(
        `data: ${JSON.stringify({ id: "fixture", model: input.model, choices: [{ index: 0, delta: { role: "assistant", content: "Model connected." }, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132, prompt_tokens_details: { cached_tokens: 20 } } })}\n\ndata: [DONE]\n\n`,
      );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
test.afterEach(async ({ request }) => {
  let data = await (await request.get(`${api}/api/v2/workspace/models`)).json();
  for (const e of data.endpoints)
    if (e.name === "Settings test")
      await request.delete(`${api}/api/v2/model-endpoints/${e.id}?expectedRevision=${e.revision}`);
  data = await (await request.get(`${api}/api/v2/workspace/models`)).json();
  await request.post(`${api}/api/v2/workspace/models/select`, {
    data: { id: "startup", expectedSelectedId: data.selectedId },
  });
});

test("模型设置：共享 API 密钥、获取列表、测试、保存与用量统计", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^(切换画布|Switch canvas)$/ })).toBeVisible();
  await page.keyboard.press("Control+,");
  const dialog = page.getByRole("main", { name: "设置", exact: true });
  await dialog.getByRole("button", { name: "模型", exact: true }).click();
  await dialog.getByRole("button", { name: "添加 API 端点", exact: true }).click();
  await dialog.getByLabel("端点名称", { exact: true }).fill("Settings test");
  await dialog.getByLabel("模型 API 地址", { exact: true }).fill(endpoint);
  await dialog.getByRole("textbox", { name: "API key", exact: true }).fill("settings-private-key");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog
    .locator(".settings-endpoint")
    .filter({ hasText: "Settings test" })
    .getByRole("button", { name: "添加模型", exact: true })
    .click();
  await dialog.getByLabel("模型", { exact: true }).selectOption("settings-research");
  await dialog.getByRole("slider", { name: "推理强度", exact: true }).press("End");
  fail = true;
  await dialog.getByRole("button", { name: "测试模型", exact: true }).click();
  await page.getByRole("button", { name: "发送测试请求", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByLabel("模型 ID", { exact: true })).toHaveValue("settings-research");
  fail = false;
  await dialog.getByRole("button", { name: "测试模型", exact: true }).click();
  await page.getByRole("button", { name: "发送测试请求", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("连接成功");
  expect(calls.at(-1).reasoning_effort).toBe("high");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog
    .getByLabel("服务器默认模型", { exact: true })
    .selectOption({ label: "settings-research" });
  const directory = await (await request.get(`${api}/api/v2/workspace/models`)).json();
  expect(JSON.stringify(directory)).not.toContain("settings-private-key");
  expect(directory.profiles.find((p: any) => p.id === directory.selectedId).modelId).toBe(
    "settings-research",
  );
  await dialog
    .locator(".settings-endpoint")
    .filter({ hasText: "Settings test" })
    .getByRole("button", { name: "管理端点：Settings test", exact: true })
    .click();
  await page.getByRole("button", { name: "编辑 API 端点", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "API key", exact: true })).toHaveValue("");
  await expect(dialog.getByRole("textbox", { name: "API key", exact: true })).toHaveAttribute(
    "placeholder",
    "已保存，留空保留",
  );
  await dialog.getByLabel("模型 API 地址", { exact: true }).fill("http://localhost:1/v1");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog.getByRole("alertdialog", { name: "有未保存的修改" })).toBeVisible();
  await dialog.getByRole("button", { name: "放弃修改", exact: true }).click();
  await dialog.getByRole("button", { name: "运行与用量", exact: true }).click();
  const runs = dialog;
  await expect(runs.getByText("模型 Token 用量", { exact: true })).toBeVisible();
  const modelUsage = runs.locator(".settings-usage-row").filter({
    has: page.getByRole("heading", { name: "openai/settings-research", exact: true }),
  });
  await expect(modelUsage.getByText("120", { exact: true })).toBeVisible();
  await expect(modelUsage.getByText("12", { exact: true })).toBeVisible();
  const violations = (await new AxeBuilder({ page }).include("main").analyze()).violations.filter(
    (v) => ["critical", "serious"].includes(v.impact ?? ""),
  );
  expect(violations).toEqual([]);
});

test("API 端点通过复选框设置无密钥，密钥可保存、保留、更新和清除", async ({ page, request }) => {
  await page.goto("/#settings/models");
  const settings = page.getByRole("main", { name: "设置", exact: true });
  const group = settings.locator(".settings-endpoint").filter({ hasText: "Settings test" });
  const editor = page.getByRole("dialog", { name: /^(添加|编辑) API 端点$/ });
  const key = editor.getByRole("textbox", { name: "API key", exact: true });
  const noKey = editor.getByRole("checkbox", { name: "无需 API 密钥", exact: true });
  const save = async () => {
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await expect(editor).toHaveCount(0);
  };
  const edit = async () => {
    await group.getByRole("button", { name: "管理端点：Settings test", exact: true }).click();
    await page.getByRole("button", { name: "编辑 API 端点", exact: true }).click();
  };
  const verifyCredential = async (secret: string) => {
    const directory = await (await request.get(`${api}/api/v2/workspace/models`)).json();
    expect(
      directory.endpoints.find((item: { name: string }) => item.name === "Settings test").hasKey,
    ).toBe(Boolean(secret));
    expect(JSON.stringify(directory)).not.toMatch(/settings-(initial|updated)-key/);
    await group.getByRole("button", { name: "添加模型", exact: true }).click();
    const model = page.getByRole("dialog", { name: "添加模型", exact: true });
    await expect(model.getByLabel("模型", { exact: true })).toContainText("settings-research");
    if (secret) expect(authorizations.at(-1)).toBe(`Bearer ${secret}`);
    else expect(authorizations.at(-1)).not.toMatch(/settings-(initial|updated)-key/);
    await model.getByRole("button", { name: "取消", exact: true }).click();
    await expect(model).toHaveCount(0);
  };

  await settings.getByRole("button", { name: "添加 API 端点", exact: true }).click();
  await editor.getByLabel("端点名称", { exact: true }).fill("Settings test");
  await editor.getByLabel("模型 API 地址", { exact: true }).fill(endpoint);
  await expect(noKey).not.toBeChecked();
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(key).toBeFocused();
  await expect(editor.getByRole("alert")).toHaveText("请填写此项。");
  await noKey.check();
  await expect(key).toBeDisabled();
  await save();
  await verifyCredential("");

  await edit();
  await expect(noKey).toBeChecked();
  await noKey.uncheck();
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(key).toBeFocused();
  await key.fill("settings-initial-key");
  await noKey.check();
  await noKey.uncheck();
  await expect(key).toHaveValue("settings-initial-key");
  await save();
  await verifyCredential("settings-initial-key");

  await edit();
  await expect(noKey).not.toBeChecked();
  await expect(key).toHaveValue("");
  await expect(key).toHaveAttribute("placeholder", "已保存，留空保留");
  await save();
  await verifyCredential("settings-initial-key");

  await edit();
  await key.fill("settings-updated-key");
  await save();
  await verifyCredential("settings-updated-key");

  await edit();
  await noKey.check();
  await expect(key).toBeDisabled();
  await save();
  await verifyCredential("");
  await page.reload();
  await edit();
  await expect(noKey).toBeChecked();
  await expect(key).toHaveValue("");
  await expect(key).toBeDisabled();
});

test("中英文设置、动态并发、冲突、草稿与窄屏服务器目录", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^(切换画布|Switch canvas)$/ })).toBeVisible();
  await page.keyboard.press("Control+,");
  let dialog = page.getByRole("main", { name: "设置", exact: true });
  await dialog.getByLabel("语言", { exact: true }).selectOption("en");
  dialog = page.getByRole("main", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await dialog.getByRole("button", { name: "Run limits", exact: true }).click();
  await dialog.getByLabel("Concurrent conversation limit", { exact: true }).fill("16");
  await dialog.getByRole("button", { name: "General", exact: true }).click();
  await expect(dialog.getByRole("alertdialog")).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(dialog.getByLabel("Concurrent conversation limit", { exact: true })).toHaveValue(
    "16",
  );
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("status")).toBeVisible();
  const saved = await (await request.get(`${api}/api/v2/settings/execution`)).json();
  expect(saved.policy.agents).toBe(16);
  await dialog.getByLabel("Concurrent conversation limit", { exact: true }).fill("24");
  await request.put(`${api}/api/v2/settings/execution`, {
    data: { expectedRevision: saved.revision, policy: { ...saved.policy, agents: 64 } },
  });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("changed elsewhere");
  await expect(dialog.getByLabel("Concurrent conversation limit", { exact: true })).toHaveValue(
    "24",
  );
  await dialog.getByRole("button", { name: "Reload latest values", exact: true }).click();
  await page
    .getByRole("alertdialog", { name: "Reload settings", exact: true })
    .getByRole("button", { name: "Discard changes and reload", exact: true })
    .click();
  await expect(dialog.getByLabel("Concurrent conversation limit", { exact: true })).toHaveValue(
    "64",
  );
  await page.setViewportSize({ width: 320, height: 600 });
  await dialog.getByRole("button", { name: "Server connections", exact: true }).click();
  await dialog.getByRole("button", { name: "Add server", exact: true }).click();
  await dialog
    .getByLabel("Name", { exact: true })
    .fill("Remote server with a very long readable name");
  await dialog.getByLabel("Server address", { exact: true }).fill("https://intrica.example.com");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByText("https://intrica.example.com", { exact: true })).toBeVisible();
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("settings-english-narrow.png") });
  await dialog
    .getByRole("button", {
      name: "Manage connection: Remote server with a very long readable name",
      exact: true,
    })
    .click();
  await dialog.getByRole("button", { name: "Remove connection", exact: true }).click();
  await dialog
    .getByRole("dialog", { name: "Remove connection", exact: true })
    .getByRole("button", { name: "Confirm removal", exact: true })
    .click();
  await expect(dialog.getByText("https://intrica.example.com", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "General", exact: true }).click();
  await dialog.getByLabel("Language", { exact: true }).selectOption("zh-CN");
  await page
    .getByRole("main", { name: "设置", exact: true })
    .getByRole("button", { name: "返回画布", exact: true })
    .click();
  await page.getByRole("button", { name: "切换画布", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索或新建画布" }).fill("语言切换保留内容");
  await page.getByRole("button", { name: "新建画布", exact: true }).click();
  await expect(page.getByRole("button", { name: "切换画布", exact: true })).toContainText(
    "语言切换保留内容",
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "切换画布", exact: true })).toContainText(
    "语言切换保留内容",
  );
});
