import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

test("HTTP 环境不提供 randomUUID 时仍能连接并新建画布", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "切换画布", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "切换画布", exact: true }).click();
  await page.getByLabel("搜索或新建画布").fill("HTTP 连接验证");
  await page.getByRole("button", { name: "新建画布", exact: true }).click();
  await expect(page.getByRole("button", { name: "切换画布", exact: true })).toContainText(
    "HTTP 连接验证",
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "切换画布", exact: true })).toContainText(
    "HTTP 连接验证",
  );
});

const api = API_URL;
const headers = { Authorization: "Bearer intrica-e2e-token" };
test.use({ actionTimeout: 10000 });

test("双击查看详情；连线拖到空白或自身后立即取消，后续点击不会连线", async ({ page, request }) => {
  const board = (
    await (
      await request.post(`${api}/api/v2/canvases`, {
        data: { title: "交互修正验收", idempotencyKey: randomUUID() },
      })
    ).json()
  ).node;
  const create = async (kind: string, title: string, x: number, parentId = board.id) =>
    (
      await (
        await request.post(`${api}/api/v2/nodes`, {
          data: {
            kind,
            title,
            parentId,
            text: kind === "text" ? "完整正文" : undefined,
            agent:
              kind === "agent" ? { persona: "检查资料", role: "read", enabled: false } : undefined,
            position: { x, y: 160, width: 220, height: kind === "agent" ? 300 : 160 },
            idempotencyKey: randomUUID(),
          },
        })
      ).json()
    ).node;
  const a = await create("text", "线索甲", 70);
  const b = await create("text", "资料容器", 420);
  await create("text", "内部资料", 0, b.id);
  const agent = await create("agent", "分析员", 760);
  await page.goto("/");
  await page.getByLabel("切换画布", { exact: true }).click();
  await page.getByRole("button", { name: "交互修正验收", exact: true }).click();
  for (const node of [a, b, agent]) {
    const card = page.locator(`[data-node-id="${node.id}"]`);
    await card.dblclick();
    await expect(page.getByLabel(`节点详情：${node.title}`, { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: /临时内部空间/ })).toHaveCount(0);
    await page.getByLabel("关闭详情侧栏", { exact: true }).click();
  }
  const source = page.locator(`[data-node-id="${a.id}"]`);
  const target = page.locator(`[data-node-id="${b.id}"]`);
  const drag = async (x: number, y: number) => {
    const rect = (await source.boundingBox())!;
    await page.mouse.move(rect.x + rect.width - 2, rect.y + rect.height / 2);
    const port = (await source.getByLabel("从 线索甲 拖动连接", { exact: true }).boundingBox())!;
    await page.mouse.move(port.x + port.width / 2, port.y + port.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 6 });
    await expect(page.locator(".link-preview path")).toHaveCount(1);
    await page.mouse.up();
    await expect(page.locator(".link-preview path")).toHaveCount(0);
    await expect(page.locator(".link-hint")).toHaveCount(0);
  };
  await drag(650, 540);
  await target.click();
  await expect(page.locator(".edge-user")).toHaveCount(0);
  if (await page.getByLabel("关闭详情侧栏", { exact: true }).isVisible())
    await page.getByLabel("关闭详情侧栏", { exact: true }).click();
  const own = (await source.boundingBox())!;
  await drag(own.x + own.width / 2, own.y + own.height / 2);
  await expect(page.locator(".edge-user")).toHaveCount(0);
  const destination = (await target.boundingBox())!;
  await drag(destination.x + destination.width / 2, destination.y + destination.height / 2);
  await expect(page.locator(".edge-user")).toHaveCount(1);
  await target.dblclick();
  await expect(page.getByLabel("节点详情：资料容器", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "进入内部", exact: true }).first().click();
  await expect(page.getByRole("region", { name: /临时内部空间.*资料容器/ })).toBeVisible();
});

test("复用 endpoint、切换协议保留密钥，拒绝 developer 的服务仍可运行推理模型", async ({
  page,
  request,
}) => {
  const calls: Array<{ method: string | undefined; url: string; key: string; body: any }> = [];
  const server: Server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    calls.push({
      method: req.method,
      url: req.url ?? "",
      key: String(req.headers.authorization ?? req.headers["x-api-key"] ?? ""),
      body,
    });
    if (req.method === "GET") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ data: [{ id: "reuse-12-b", reasoning_efforts: ["none", "high"] }] }));
      return;
    }
    if (body.messages.some((message: any) => message.role === "developer")) {
      res
        .writeHead(400, { "content-type": "application/json" })
        .end('{"error":{"message":"Invalid request: role developer is not allowed"}}');
      return;
    }
    res
      .writeHead(200, { "content-type": "text/event-stream" })
      .end(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "模型连接正常" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  try {
    const endpoint = await (
      await request.post(`${api}/api/v2/model-endpoints`, {
        data: { name: "已保存本地服务", baseUrl, apiKey: "reuse-private-key" },
      })
    ).json();
    const saved = await (
      await request.post(`${api}/api/v2/workspace/models`, {
        headers,
        data: {
          name: "已保存本地服务",
          provider: "custom",
          api: "openai-completions",
          endpointId: endpoint.savedId,
          modelId: "reuse-12-a",
          reasoning: true,
          supportsVision: false,
          thinkingLevel: "high",
        },
      })
    ).json();
    await page.goto("/");
    await page.getByLabel("选择模型", { exact: true }).click();
    await page.getByRole("button", { name: "管理模型…", exact: true }).click();
    const dialog = page.getByRole("main", { name: "设置", exact: true });
    await dialog
      .locator(".settings-endpoint")
      .filter({ hasText: "已保存本地服务" })
      .getByRole("button", { name: "添加模型", exact: true })
      .click();
    await dialog.getByLabel("协议", { exact: true }).selectOption("anthropic-messages");
    await dialog.getByLabel("模型", { exact: true }).selectOption("reuse-12-b");
    expect(calls.findLast((call) => call.method === "GET")).toMatchObject({
      url: "/v1/models",
      key: "reuse-private-key",
    });
    await dialog.getByLabel("协议", { exact: true }).selectOption("openai-completions");
    await dialog.getByRole("slider", { name: "推理强度", exact: true }).press("End");
    await dialog.getByRole("button", { name: "测试模型", exact: true }).click();
    await page.getByRole("button", { name: "发送测试请求", exact: true }).click();
    await expect(dialog.getByRole("status")).toHaveText("连接成功");
    const refresh = dialog.getByRole("button", { name: "刷新模型", exact: true });
    await expect(refresh).toBeEnabled();
    const discovery = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/v2/workspace/models/discover",
    );
    await refresh.click();
    expect((await discovery).ok()).toBe(true);
    expect(calls.at(-1)).toMatchObject({ method: "GET", url: "/v1/models" });
    expect(
      calls.findLast((call) => call.method === "POST" && call.url === "/v1/chat/completions"),
    ).toMatchObject({
      key: "Bearer reuse-private-key",
      body: {
        model: "reuse-12-b",
        reasoning_effort: "high",
        messages: expect.arrayContaining([expect.objectContaining({ role: "system" })]),
      },
    });
    await page.screenshot({ path: test.info().outputPath("endpoint-protocol.png") });
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog.locator("form")).toHaveCount(0);
    const state = await (await request.get(`${api}/api/v2/workspace/models`, { headers })).json();
    expect(state.profiles.filter((p: any) => p.endpointId === endpoint.savedId)).toHaveLength(2);
    expect(state.endpoints.filter((e: any) => e.id === endpoint.savedId)).toHaveLength(1);
    expect(state.profiles.find((profile: any) => profile.id === saved.savedId).modelId).toBe(
      "reuse-12-a",
    );
    expect(JSON.stringify(state)).not.toContain("reuse-private-key");
  } finally {
    const state = await (await request.get(`${api}/api/v2/workspace/models`, { headers })).json();
    for (const profile of state.profiles)
      if (profile.modelId.startsWith("reuse-12-"))
        await request.delete(
          `${api}/api/v2/workspace/models/${profile.id}?expectedRevision=${profile.revision}`,
          { headers },
        );
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
