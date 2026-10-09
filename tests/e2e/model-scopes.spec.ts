import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

test.use({ actionTimeout: 10000 });
const api = API_URL;
const headers = { Authorization: "Bearer intrica-e2e-token" };
let server: Server;
let endpoint: string;
let requests: any[];
test.beforeAll(async () => {
  requests = [];
  server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          data: [
            { id: "quick-11", reasoning_efforts: ["none"] },
            { id: "research-11", reasoning_efforts: ["none", "low", "high", "max"] },
          ],
        }),
      );
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: `当前回答模型 ${body.model}` }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
test.afterEach(async ({ request }) => {
  const data = await (await request.get(`${api}/api/v2/workspace/models`, { headers })).json();
  for (const profile of data.profiles ?? [])
    if (profile.modelId.endsWith("-11"))
      await request.delete(
        `${api}/api/v2/workspace/models/${profile.id}?expectedRevision=${profile.revision}`,
        { headers },
      );
  const current = await (await request.get(`${api}/api/v2/workspace/models`)).json();
  await request.post(`${api}/api/v2/workspace/models/select`, {
    data: { id: "startup", expectedSelectedId: current.selectedId },
  });
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("画布菜单脱离裁剪，多画布滚动及统一输入始终可达", async ({ page, request }) => {
  for (let i = 0; i < 12; i++)
    await request.post(`${api}/api/v2/canvases`, {
      data: { title: `选择栏 ${i} · 调查与证据工作区`, idempotencyKey: randomUUID() },
    });
  await page.goto("/");
  await page.setViewportSize({ width: 700, height: 540 });
  await page.getByLabel("打开侧栏", { exact: true }).click();
  await page.getByLabel("切换画布", { exact: true }).click();
  const menu = page.getByRole("dialog", { name: "画布切换", exact: true });
  const geometry = await menu.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const list = el.querySelector(".canvas-menu-list")!;
    return {
      left: r.left,
      right: r.right,
      bottom: r.bottom,
      scrolls: list.scrollHeight > list.clientHeight,
    };
  });
  expect(geometry).toMatchObject({ scrolls: true });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(700);
  expect(geometry.bottom).toBeLessThanOrEqual(540);
  await menu.getByRole("button", { name: "选择栏 11 · 调查与证据工作区", exact: true }).click();
  await expect(page.getByLabel("切换画布", { exact: true })).toContainText("选择栏 11");
  await page.getByLabel("切换画布", { exact: true }).click();
  await page.getByLabel("搜索或新建画布").fill("从完整菜单创建");
  await page.getByLabel("新建画布", { exact: true }).click();
  await expect(page.getByLabel("切换画布", { exact: true })).toContainText("从完整菜单创建");
  await page.getByLabel("切换画布", { exact: true }).click();
  await expect(menu.locator('[aria-current="page"]')).toBeInViewport({ ratio: 0.9 });
  await page.screenshot({ path: test.info().outputPath("canvas-menu.png") });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("Agent 与模型会话独立选择模型及推理强度，并保留服务器默认模型", async ({ page, request }) => {
  await page.goto("/");
  const endpointData = await (
    await request.post(`${api}/api/v2/model-endpoints`, {
      data: { name: "Scoped models", baseUrl: endpoint, apiKey: "scoped-test-key" },
    })
  ).json();
  const make = async (modelId: string, reasoning: boolean) =>
    (
      await request.post(`${api}/api/v2/workspace/models`, {
        data: {
          endpointId: endpointData.savedId,
          name: modelId,
          modelId,
          provider: "openai",
          api: "openai-completions",
          reasoning,
          supportsVision: false,
          thinkingLevel: reasoning ? "max" : "off",
          thinkingLevels: reasoning ? ["off", "low", "high", "max"] : ["off"],
        },
      })
    ).json();
  const quick = await make("quick-11", false);
  const researchData = await make("research-11", true);
  await request.post(`${api}/api/v2/workspace/models/select`, {
    data: { id: quick.savedId, expectedSelectedId: researchData.selectedId },
  });
  const initial = await (await request.get(`${api}/api/v2/workspace/models`, { headers })).json();
  const board = (
    await (
      await request.post(`${api}/api/v2/canvases`, {
        data: { title: "独立模型验收", idempotencyKey: randomUUID() },
      })
    ).json()
  ).node;
  const agent = (
    await (
      await request.post(`${api}/api/v2/nodes`, {
        data: {
          kind: "agent",
          title: "模型研究员",
          parentId: board.id,
          agent: { persona: "简短回答", role: "read", enabled: false },
          position: { x: 120, y: 150, width: 220, height: 300 },
          idempotencyKey: randomUUID(),
        },
      })
    ).json()
  ).node;
  await page.reload();
  await page.getByLabel("切换画布", { exact: true }).click();
  await page.getByRole("button", { name: "独立模型验收", exact: true }).click();
  await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
  await page.getByLabel("Agent 模型", { exact: true }).click();
  await page.getByRole("option", { name: /research-11/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Agent 模型", { exact: true })).toContainText("research-11");
  let saved = await (await request.get(`${api}/api/v2/workspace/models`, { headers })).json();
  expect(saved.selectedId).toBe(initial.selectedId);
  const research = saved.profiles.find((profile: any) => profile.modelId === "research-11");
  const snapshot = async () =>
    (await (await request.get(`${api}/api/v2/bootstrap?canvasId=${board.id}`)).json()).nodes.find(
      (node: any) => node.id === agent.id,
    );
  await expect
    .poll(async () => (await snapshot()).agent.model)
    .toEqual({ profileId: research.id, thinkingLevel: "max" });
  await page.getByRole("button", { name: "运行", exact: true }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  expect(requests.at(-1)).toMatchObject({ model: "research-11", reasoning_effort: "max" });
  expect(requests.at(-1).tools.some((tool: any) => tool.function.name === "web_search")).toBe(true);
  await page.getByRole("button", { name: "模型会话", exact: true }).click();
  await page.getByLabel("对话模型", { exact: true }).click();
  await page.getByRole("option", { name: /research-11/ }).click();
  await page.getByRole("slider", { name: "推理强度", exact: true }).press("Home");
  await page.getByRole("slider", { name: "推理强度", exact: true }).press("ArrowRight");
  await page.keyboard.press("Escape");
  await page.getByLabel("模型问题").fill("按当前独立配置回答");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("当前回答模型 research-11", { exact: true }).last()).toBeVisible();
  expect(requests.at(-1)).toMatchObject({ model: "research-11", reasoning_effort: "low" });
  expect((await snapshot()).agent.model.thinkingLevel).toBe("max");
  await page.getByLabel("对话模型", { exact: true }).click();
  await page.getByRole("option", { name: /跟随服务器默认/ }).click();
  await page.keyboard.press("Escape");
  await page.getByLabel("模型问题").fill("使用工作区默认回答");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("当前回答模型 quick-11", { exact: true })).toBeVisible();
  expect(requests.at(-1).model).toBe("quick-11");
  saved = await (await request.get(`${api}/api/v2/workspace/models`, { headers })).json();
  expect(saved.selectedId).toBe(initial.selectedId);
  await page.screenshot({ path: test.info().outputPath("scoped-model.png") });
  await request.delete(
    `${api}/api/v2/workspace/models/${research.id}?expectedRevision=${research.revision}`,
    { headers },
  );
  await page.reload();
  await page.getByLabel("切换画布", { exact: true }).click();
  await page.getByRole("button", { name: "独立模型验收", exact: true }).click();
  await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
  await expect(page.getByLabel("Agent 模型", { exact: true })).toContainText("配置已删除");
  const before = requests.length;
  await page.getByRole("button", { name: "运行", exact: true }).click();
  await expect(page.getByText(/Select a configured model|模型/).first()).toBeVisible();
  expect(requests.length).toBe(before);
});
