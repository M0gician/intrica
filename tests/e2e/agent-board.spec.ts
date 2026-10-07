import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

const api = API_URL;

test("新画布保留旧画布；点击快捷栏、拖拽提示、默认渲染、连线删除和 Agent 配置", async ({
  page,
  request,
}) => {
  const initialBoard = (
    await (
      await request.post(`${api}/api/v2/canvases`, {
        data: { title: "交互验证", idempotencyKey: randomUUID() },
      })
    ).json()
  ).node;
  const create = async (title: string, x: number, extra = {}) => {
    const response = await request.post(`${api}/api/v2/nodes`, {
      data: {
        kind: "text",
        parentId: initialBoard.id,
        title,
        text: "# 已有正文\n\n**重点**内容",
        position: { x, y: 220, width: 240, height: 160 },
        idempotencyKey: randomUUID(),
        ...extra,
      },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()).node;
  };
  const one = await create("快捷栏验证", 120);
  const two = await create("连接验证", 500);
  const snapshot = await (
    await request.get(`${api}/api/v2/bootstrap?canvasId=${initialBoard.id}`)
  ).json();
  const edgeResponse = await request.post(`${api}/api/v2/links`, {
    data: {
      fromId: one.id,
      toId: two.id,
      expectedGraphRevision: snapshot.graphRevision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(edgeResponse.ok()).toBe(true);
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: "交互验证", exact: true }).click();
  const card = page.locator(`[data-node-id="${one.id}"]`);
  await card.click();
  await page.mouse.move(900, 600);
  const toolbar = page.getByRole("toolbar", { name: "节点操作" });
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "查看详情" })).toBeVisible();
  await toolbar.getByRole("button", { name: "查看详情" }).click();
  await expect(page.getByRole("heading", { name: "已有正文" })).toBeVisible();
  await expect(card.locator(".drag-grip")).toHaveCount(0);
  await expect(card.locator(".node-type-icon")).toBeVisible();
  await expect(card.locator(".node-card-header")).toHaveCSS("cursor", "grab");
  await page.getByRole("button", { name: "关闭详情侧栏" }).click();
  const header = (await card.locator("header").boundingBox())!;
  await page.mouse.move(header.x + 50, header.y + 14);
  await page.mouse.down();
  await page.mouse.move(header.x + 180, header.y + 50);
  await expect(card).toHaveClass(/node-dragging/);
  await expect(card).toHaveCSS("z-index", "100");
  await expect(card).toHaveCSS("transition-duration", "0s");
  await page.mouse.up();
  await expect(card).not.toHaveClass(/node-dragging/);
  const edge = page.getByRole("button", { name: "连接：快捷栏验证 ↔ 连接验证，可删除" });
  await expect(edge).toBeVisible();
  await expect(edge).not.toHaveAttribute("marker-end");
  const hitAblation = await edge.evaluate((element) => {
    const path = element as SVGPathElement;
    const point = path.getPointAtLength(path.getTotalLength() / 2);
    const matrix = path.getScreenCTM()!;
    const center = new DOMPoint(point.x, point.y).matrixTransform(matrix);
    const countHits = () =>
      Array.from({ length: 15 }, (_, i) => i - 7).filter(
        (offset) => document.elementFromPoint(center.x, center.y + offset) === path,
      ).length;
    const finalHits = countHits();
    const previous = path.style.strokeWidth;
    path.style.strokeWidth = "1.5px";
    const thinHits = countHits();
    path.style.strokeWidth = previous;
    return { finalHits, thinHits, sampleCount: 15 };
  });
  expect(hitAblation.finalHits).toBeGreaterThan(hitAblation.thinHits);
  writeFileSync(
    test.info().outputPath("edge-hit-ablation.json"),
    JSON.stringify(hitAblation, null, 2),
  );
  await test.info().attach("edge-hit-ablation.json", {
    body: JSON.stringify(hitAblation),
    contentType: "application/json",
  });
  await edge.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Delete");
  await expect(edge).toHaveCount(0);
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: "新建画布", exact: true }).click();
  await expect(card).toHaveCount(0);
  const canvases = await (
    await request.get(`${api}/api/v2/bootstrap?canvasId=${initialBoard.id}`)
  ).json();
  expect(canvases.nodes.some((n: any) => n.id === one.id)).toBe(true);
  const board = canvases.nodes.find(
    (n: any) => n.parentId === null && n.id !== "canvas-e2e" && n.id !== initialBoard.id,
  );
  expect(board).toBeTruthy();
  await page.getByRole("button", { name: "新建节点", exact: true }).click();
  await page.getByRole("menuitem", { name: "Agent", exact: true }).click();
  await page.getByRole("menuitem", { name: "只读", exact: true }).click();
  await expect(page.getByLabel("Agent 性格与职责")).toBeVisible();
  await page.getByLabel("Agent 性格与职责").fill("严谨的研究员，优先检查连接的证据。");
  await page.getByRole("button", { name: "Agent 访问权限" }).click();
  await page.getByText("调整角色", { exact: true }).click();
  await page.getByRole("radio", { name: "读写", exact: true }).check();
  await expect(page.locator(".agent-card .agent-portrait")).toBeVisible();
  await page.getByLabel("Agent 任务").fill("读取画布摘要，说明有哪些已连接的资源。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByLabel("Agent 共享会话").getByText("读取画布", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByLabel("Agent 共享会话").getByText("本次运行已结束。", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("agent-node.png") });
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: "交互验证", exact: true }).click();
  await expect(card).toBeVisible();
});

test("扩展逐项接受及重试，未选择内容保留", async ({ page, request }) => {
  const boardRes = await request.post(`${api}/api/v2/canvases`, {
    data: { title: "逐项审阅", idempotencyKey: randomUUID() },
  });
  const board = (await boardRes.json()).node;
  const sourceRes = await request.post(`${api}/api/v2/nodes`, {
    data: {
      kind: "text",
      title: "独立审阅来源",
      text: "证据 A",
      parentId: board.id,
      position: { x: 100, y: 160, width: 240, height: 160 },
      idempotencyKey: randomUUID(),
    },
  });
  const source = (await sourceRes.json()).node;
  const response = await request.post(`${api}/api/v2/operations`, {
    data: {
      type: "expand",
      scopeId: board.id,
      selection: [source.id],
      includeDescendants: [],
      includeConnected: false,
      instruction: "",
      idempotencyKey: randomUUID(),
    },
  });
  const op = (await response.json()).operation;
  await expect
    .poll(
      async () =>
        (await (await request.get(`${api}/api/v2/operations/${op.id}`)).json()).operation.status,
    )
    .toBe("candidate");
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: "逐项审阅", exact: true }).click();
  await page.getByRole("button", { name: "逐个查看" }).click();
  const items = page.locator(".review-candidate");
  const count = await items.count();
  expect(count).toBeGreaterThan(1);
  await items.first().getByRole("button", { name: "接受此项" }).click();
  await expect(items).toHaveCount(count - 1);
  await items.first().getByRole("button", { name: "重试此项" }).click();
  await expect(items.first().getByRole("button", { name: "重试此项" })).toBeEnabled();
  await expect(items).toHaveCount(count - 1);
  await page
    .getByRole("complementary", { name: "扩展审阅：未提交" })
    .getByRole("button", { name: "接受全部" })
    .click();
  await expect
    .poll(
      async () =>
        (
          await (await request.get(`${api}/api/v2/bootstrap?canvasId=${board.id}`)).json()
        ).candidateNodes.filter((n: any) => n.operationId === op.id).length,
    )
    .toBe(0);
});
