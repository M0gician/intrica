import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

const api = API_URL;
test("类型菜单、肖像卡、整组拖线、连线高亮和悬停删除", async ({ page, request }) => {
  const board = (
    await (
      await request.post(`${api}/api/v2/canvases`, {
        data: { title: "直接操作", idempotencyKey: randomUUID() },
      })
    ).json()
  ).node;
  const create = async (title: string, y: number) =>
    (
      await (
        await request.post(`${api}/api/v2/nodes`, {
          data: {
            kind: "text",
            title,
            parentId: board.id,
            text: "证据",
            position: { x: 80, y, width: 220, height: 150 },
            idempotencyKey: randomUUID(),
          },
        })
      ).json()
    ).node;
  const a = await create("资料甲", 160),
    b = await create("资料乙", 400);
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: "直接操作", exact: true }).click();
  await page.mouse.dblclick(800, 320);
  await expect(page.getByRole("menu", { name: "新建菜单" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Agent", exact: true }).click();
  await page.getByRole("menuitem", { name: "只读", exact: true }).click();
  const agent = page.locator(".agent-card");
  await expect(agent).toBeVisible();
  await expect(agent.locator(".agent-portrait")).toBeVisible();
  const photo = (await agent.locator(".agent-portrait").boundingBox())!,
    card = (await agent.boundingBox())!;
  expect(photo.height).toBeGreaterThan(card.height * 0.55);
  await expect(page.getByLabel("Agent 性格与职责")).toBeVisible();
  await page.getByRole("button", { name: "关闭详情侧栏" }).click();
  const first = page.locator(`[data-node-id="${a.id}"]`),
    second = page.locator(`[data-node-id="${b.id}"]`);
  await first.click();
  await second.click({ modifiers: ["Shift"] });
  if (await page.getByRole("button", { name: "关闭详情侧栏" }).isVisible())
    await page.getByRole("button", { name: "关闭详情侧栏" }).click();
  const fromBounds = (await first.boundingBox())!;
  await page.mouse.move(fromBounds.x + fromBounds.width - 2, fromBounds.y + fromBounds.height / 2);
  const source = (await first.getByRole("button", { name: "从 资料甲 拖动连接" }).boundingBox())!;
  const target = (await agent.boundingBox())!;
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await expect(page.locator(".link-preview path")).toHaveCount(2);
  await expect(agent).toHaveClass(/link-target/);
  await page.mouse.up();
  await expect(page.locator(".edge-user")).toHaveCount(2);
  const edge = page.locator(".edge-hit").first();
  await edge.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".edge-selected")).toHaveCount(1);
  await expect(page.locator(".edge-selected .edge-visible")).toHaveCSS(
    "stroke",
    "rgb(206, 100, 63)",
  );
  await page.keyboard.press("Escape");
  const midpoint = await edge.evaluate((el) => {
    const p = el as SVGPathElement;
    const q = p.getPointAtLength(p.getTotalLength() / 2);
    const xy = new DOMPoint(q.x, q.y).matrixTransform(p.getScreenCTM()!);
    return { x: xy.x, y: xy.y };
  });
  await page.mouse.move(midpoint.x, midpoint.y);
  const remove = page.getByRole("button", { name: "删除连接", exact: true });
  await expect(remove).toHaveCSS("border-top-width", "0px");
  await expect(remove).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(remove).toHaveCSS("box-shadow", "none");
  await expect(remove.locator("svg")).toHaveCount(1);
  await expect(page.locator(".floating-card")).toHaveCount(0);

  await expect(remove).toBeVisible();
  await remove.click();
  await expect(page.locator(".edge-user")).toHaveCount(1);
  await agent.dblclick();
  await page.mouse.move(0, 0);
  await agent.hover();
  await expect(async () => {
    const actions = (await page.getByRole("toolbar", { name: "节点操作" }).boundingBox())!;
    const panel = (await page.locator(".workspace-panel").boundingBox())!;
    expect(actions.x + actions.width).toBeLessThanOrEqual(panel.x);
  }).toPass();
  await page.screenshot({ path: test.info().outputPath("portrait-and-connections.png") });
});

test("新画布菜单统一样式，右键创建；协作消息只显示真实通讯", async ({ page, request }) => {
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  await page.getByLabel("搜索或新建画布").fill("协作观察");
  await page.screenshot({ path: test.info().outputPath("canvas-menu.png") });
  await page.getByRole("button", { name: "新建画布", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "画布路径" })).toContainText("协作观察");
  await page.mouse.click(250, 220, { button: "right" });
  await page.getByRole("menuitem", { name: "Agent", exact: true }).click();
  await page.getByRole("menuitem", { name: "只读", exact: true }).click();
  await page.getByLabel("Agent 任务").fill("说明任务范围");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".agent-event-user")).toContainText("说明任务范围");
  await expect(page.locator(".agent-event-tool")).toBeVisible();
  await expect(page.getByRole("button", { name: "返回最新会话", exact: true })).toHaveCount(0);
  await expect(page.locator(".agent-event-run_status")).toContainText("本次运行已结束。");
  const serverId = (await (await request.get(`${api}/api/v2/server`)).json()).id;
  const canvasId = await page.evaluate(
    (serverId) => localStorage.getItem(`intrica:server:${serverId}:intrica:canvas`),
    serverId,
  );
  const snapshot = await (await request.get(`${api}/api/v2/bootstrap?canvasId=${canvasId}`)).json();
  const agent = snapshot.nodes.find(
    (n: any) =>
      n.kind === "agent" &&
      n.parentId === snapshot.nodes.find((n: any) => n.title === "协作观察").id,
  );
  await page.route("**/api/v2/canvas-activity?*", (route) =>
    route.fulfill({
      json: {
        graphRevision: snapshot.graphRevision,
        agents: [{ id: agent.id, status: "complete", seq: 10, messageSeq: 10 }],
        events: [
          {
            agentId: agent.id,
            kind: "message",
            seq: 10,
            data: { to: agent.id, text: "请核查新增证据" },
          },
        ],
      },
    }),
  );
  await page.getByRole("button", { name: "协作消息", exact: true }).click();
  await expect(page.getByRole("heading", { name: "协作消息" })).toBeVisible();
  await expect(page.locator(".agent-event-message")).toContainText("请核查新增证据");
  await page.screenshot({ path: test.info().outputPath("collaboration.png") });
});
