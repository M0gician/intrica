import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

let endpointServer: Server;
let baseUrl: string;
test.beforeAll(async () => {
  endpointServer = createServer(async (request, response) => {
    if (request.method === "GET") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ data: [{ id: "feedback-model" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    response
      .writeHead(200, { "content-type": "text/event-stream" })
      .end(
        `data: ${JSON.stringify({ id: "feedback", model: input.model, choices: [{ index: 0, delta: { role: "assistant", content: "Connected." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
  });
  await new Promise<void>((resolve) => endpointServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(endpointServer.address() as { port: number }).port}/v1`;
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => endpointServer.close(() => resolve()));
});
test.afterEach(async ({ request }) => {
  const directory = await (await request.get(`${API_URL}/api/v2/workspace/models`)).json();
  for (const endpoint of directory.endpoints)
    if (endpoint.name.startsWith("feedback-"))
      await request.delete(
        `${API_URL}/api/v2/model-endpoints/${endpoint.id}?expectedRevision=${endpoint.revision}`,
      );
});

async function settings(page: Page, section: "models" | "execution") {
  await page.goto(`/#settings/${section}`);
  const pageContent = page.getByRole("main", { name: "设置", exact: true });
  await expect(pageContent).toBeVisible();
  return pageContent;
}

async function endpoint(request: APIRequestContext) {
  const name = `feedback-${randomUUID()}`;
  const response = await request.post(`${API_URL}/api/v2/model-endpoints`, {
    data: { name, baseUrl },
  });
  expect(response.ok()).toBe(true);
  const directory = await response.json();
  return directory.endpoints.find((item: { name: string }) => item.name === name);
}

test("端点直接保存与离开前保存执行相同校验，并定位输入项", async ({ page }) => {
  const pageContent = await settings(page, "models");
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/v2/model-endpoints"
    )
      writes.push(request.url());
  });
  await pageContent.getByRole("button", { name: "添加 API 端点", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "添加 API 端点", exact: true });
  const name = editor.getByLabel("端点名称", { exact: true });
  const url = editor.getByLabel("模型 API 地址", { exact: true });
  await name.fill("   ");
  await url.fill(baseUrl);
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor.getByRole("alert")).toHaveText("请填写此项。");
  await expect(name).toBeFocused();
  expect(writes).toHaveLength(0);
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  const decision = page.getByRole("alertdialog", { name: "有未保存的修改", exact: true });
  await decision.getByRole("button", { name: "保存并继续", exact: true }).click();
  await expect(decision).toHaveCount(0);
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("   ");
  expect(writes).toHaveLength(0);
  const title = `feedback-${randomUUID()}`;
  await name.fill(title);
  await url.fill("ftp://example.com");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(url).toBeFocused();
  await expect(editor.getByRole("alert")).toHaveText("请输入以 HTTP 或 HTTPS 开头的有效地址。");
  expect(writes).toHaveLength(0);
  await url.fill(baseUrl);
  await editor.getByRole("checkbox", { name: "无需 API 密钥", exact: true }).check();
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(pageContent.getByRole("heading", { name: title, exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
});

test("模型校验保留配置，连接测试结果只对应已测试的输入", async ({ page, request }) => {
  const service = await endpoint(request);
  const pageContent = await settings(page, "models");
  await pageContent
    .locator(".settings-endpoint")
    .filter({ hasText: service.name })
    .getByRole("button", { name: "添加模型", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "添加模型", exact: true });
  await editor.getByLabel("显示名称", { exact: true }).fill("Feedback model");
  await editor.getByLabel("模型 ID", { exact: true }).fill("feedback-model");
  const context = editor.getByLabel("上下文窗口（Token）", { exact: true });
  await context.fill("1");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(context).toBeFocused();
  await expect(editor.getByRole("alert")).toBeVisible();
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "保存并继续", exact: true })
    .click();
  await expect(context).toBeFocused();
  await expect(editor.getByLabel("显示名称", { exact: true })).toHaveValue("Feedback model");
  await context.fill("128000");
  await editor.getByRole("button", { name: "测试模型", exact: true }).click();
  await page.getByRole("button", { name: "发送测试请求", exact: true }).click();
  await expect(editor.getByRole("status")).toHaveText("连接成功");
  await editor.getByLabel("模型 ID", { exact: true }).fill("feedback-model-updated");
  await expect(editor.getByText("连接成功", { exact: true })).toHaveCount(0);
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(
    pageContent
      .locator(".settings-endpoint")
      .filter({ hasText: service.name })
      .locator(".settings-model-list"),
  ).toContainText("feedback-model-updated");
  const directory = await (await request.get(`${API_URL}/api/v2/workspace/models`)).json();
  expect(directory.profiles).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ endpointId: service.id, modelId: "feedback-model-updated" }),
    ]),
  );
});

test("配置冲突保留草稿，重新加载需明确放弃修改", async ({ page, request }) => {
  const service = await endpoint(request);
  const pageContent = await settings(page, "models");
  await pageContent
    .locator(".settings-endpoint")
    .filter({ hasText: service.name })
    .getByRole("button", { name: `管理端点：${service.name}`, exact: true })
    .click();
  await page.getByRole("button", { name: "编辑 API 端点", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑 API 端点", exact: true });
  const name = editor.getByLabel("端点名称", { exact: true });
  await name.fill("feedback-local-draft");
  const remoteName = `feedback-remote-${randomUUID()}`;
  const external = await request.post(`${API_URL}/api/v2/model-endpoints`, {
    data: { id: service.id, expectedRevision: service.revision, name: remoteName, baseUrl },
  });
  expect(external.ok()).toBe(true);
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("其他客户端");
  await expect(name).toHaveValue("feedback-local-draft");
  await editor.getByRole("button", { name: "重新加载最新值", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", { name: "重新加载设置", exact: true });
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(name).toHaveValue("feedback-local-draft");
  await editor.getByRole("button", { name: "重新加载最新值", exact: true }).click();
  await confirmation.getByRole("button", { name: "放弃修改并重新加载", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(pageContent.getByRole("heading", { name: remoteName, exact: true })).toBeVisible();
});

test("运行限制保存确认来自设置响应，校验失败时返回对应输入项", async ({ page, request }) => {
  const pageContent = await settings(page, "execution");
  const field = pageContent.getByLabel("会话并发上限", { exact: true });
  await expect(field).toBeVisible();
  const original = Number(await field.inputValue());
  let puts = 0;
  let overviewReads = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/v2/settings/execution" && request.method() === "PUT") puts++;
    if (path === "/api/v2/statistics/overview") overviewReads++;
  });
  await field.fill("9999");
  await pageContent.getByRole("button", { name: "保存", exact: true }).click();
  await expect(field).toBeFocused();
  expect(puts).toBe(0);
  await pageContent.getByRole("button", { name: "通用", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "保存并继续", exact: true })
    .click();
  await expect(field).toBeFocused();
  expect(puts).toBe(0);
  const target = original === 17 ? 18 : 17;
  await field.fill(String(target));
  await pageContent.getByRole("button", { name: "保存", exact: true }).click();
  await expect(pageContent.getByRole("status")).toHaveText("已保存");
  const committed = await (await request.get(`${API_URL}/api/v2/settings/execution`)).json();
  expect(committed.policy.agents).toBe(target);
  expect(puts).toBe(1);
  expect(overviewReads).toBe(0);
  await pageContent.getByRole("button", { name: "通用", exact: true }).click();
  await expect(pageContent.getByLabel("语言", { exact: true })).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await test.info().attach("execution-save-requests.json", {
    body: JSON.stringify({
      settingsWrites: puts,
      overviewReads,
      persistedAgentLimit: committed.policy.agents,
    }),
    contentType: "application/json",
  });
});
