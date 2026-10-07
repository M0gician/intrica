import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { AGENT_CAMEOS, colorContrast, PORTRAIT_SKINS, portraitColors } from "@intrica/contracts";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

const api = API_URL;
async function board(request: any, title: string) {
  return (
    await (
      await request.post(`${api}/api/v2/canvases`, {
        data: { title, idempotencyKey: randomUUID() },
      })
    ).json()
  ).node;
}
async function agent(request: any, parentId: string, title: string, index = 0) {
  const res = await request.post(`${api}/api/v2/nodes`, {
    data: {
      kind: "agent",
      parentId,
      title,
      agent: {
        persona: "核对共享资料，说明依据与不确定之处。",
        role: "admin",
        enabled: false,
        portraitVariant: index * 1379,
      },
      position: {
        x: 100 + (index % 4) * 260,
        y: 100 + Math.floor(index / 4) * 340,
        width: 220,
        height: 300,
      },
      idempotencyKey: randomUUID(),
    },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).node;
}
async function openBoard(page: any, title: string) {
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: title, exact: true }).click();
}

test("画布菜单删除与撤销，空工作区可新建", async ({ page, request }) => {
  const root = await board(request, "可删除的调查");
  const person = await agent(request, root.id, "周宁");
  await openBoard(page, root.title);
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: `${root.title}的更多操作` }).click();
  await page.getByRole("menuitem", { name: "删除画布", exact: true }).click();
  await expect(page.getByRole("form", { name: "删除画布确认" })).toContainText("全部元素和连接");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect(
    (await (await request.get(`${api}/api/v2/bootstrap?canvasId=${root.id}`)).json()).nodes.some(
      (n: any) => n.id === person.id,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: `${root.title}的更多操作` }).click();
  await page.getByRole("menuitem", { name: "删除画布", exact: true }).click();
  await page.getByRole("button", { name: "确认删除画布" }).click();
  await expect(page.locator(`[data-node-id="${person.id}"]`)).toHaveCount(0);
  await page.locator(".toast").getByRole("button", { name: "撤销", exact: true }).click();
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: root.title, exact: true }).click();
  await expect(page.locator(`[data-node-id="${person.id}"]`)).toBeVisible();
  const snapshot = await (await request.get(`${api}/api/v2/bootstrap?canvasId=${root.id}`)).json();
  // Empty-workspace rendering is isolated from other tests' saved canvases.
  await page.route("**/api/v2/bootstrap*", (route) =>
    route.fulfill({
      json: {
        ...snapshot,
        nodes: [],
        edges: [],
        operations: [],
        candidateNodes: [],
        candidateContainers: [],
      },
    }),
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "新建第一张画布" })).toBeVisible();
  await expect(page.getByRole("button", { name: "新建节点", exact: true })).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath("empty-workspace.png") });
  await page.unroute("**/api/v2/bootstrap*");
  await page.getByRole("button", { name: "新建第一张画布" }).click();
  await expect(page.locator(".empty-canvas-workspace")).toHaveCount(0);
});

test("长会话底部首次打开职责即聚焦，广播按接收者筛选且仅显示一条", async ({ page, request }) => {
  const root = await board(request, "职责与共享广播");
  const a = await agent(request, root.id, "福尔摩斯");
  const b = await agent(request, root.id, "华生", 1);
  const c = await agent(request, root.id, "灰原哀", 2);
  const resource = (
    await (
      await request.post(`${api}/api/v2/nodes`, {
        data: {
          kind: "text",
          parentId: root.id,
          title: "时间线证据",
          text: "交叉核对各人的时间记录。",
          position: { x: 300, y: 450, width: 240, height: 160 },
          idempotencyKey: randomUUID(),
        },
      })
    ).json()
  ).node;
  const events = Array.from({ length: 16 }, (_, i) => ({
    seq: i + 1,
    agentId: a.id,
    kind: "assistant",
    data: { text: "核查过程。".repeat(100) },
  }));
  const broadcast = {
    seq: 30,
    agentId: a.id,
    kind: "broadcast",
    data: { text: "请共同核对时间线。", recipients: [b.id, c.id], resourceIds: [resource.id] },
  };
  await page.route(`**/api/v2/canvas-agents/${a.id}*`, (route) =>
    route.fulfill({ json: { events: [...events, broadcast], running: false, requests: [] } }),
  );
  await openBoard(page, root.title);
  await page.locator(`[data-node-id="${a.id}"]`).dblclick();
  await expect(page.locator(".agent-event-broadcast")).toContainText("广播给 2 位 Agent");
  await page.getByRole("button", { name: "Agent 能力与设置" }).click();
  await page.getByRole("button", { name: "性格与职责 编辑 ↗" }).click();
  const field = page.getByLabel("Agent 性格与职责");
  await expect(field).toBeFocused();
  await expect(field).toBeInViewport();
  events.push({
    seq: 31,
    agentId: a.id,
    kind: "assistant",
    data: { text: "新的流式内容".repeat(100) },
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".agent-activity")).toContainText("新的流式内容");
  await expect(field).toBeFocused();
  await expect(field).toBeInViewport();
  await page.getByRole("button", { name: "重新生成肖像" }).click();
  await expect(page.locator(".agent-profile .agent-portrait")).toHaveAttribute(
    "data-character",
    "福尔摩斯",
  );
  await page.route("**/api/v2/canvas-activity?*", (route) =>
    route.fulfill({
      json: {
        graphRevision: 0,
        agents: [
          { id: a.id, status: "complete", seq: 30, messageSeq: 30 },
          { id: b.id, status: "complete", seq: 30, messageSeq: 30 },
        ],
        events: [broadcast],
      },
    }),
  );
  await page.getByRole("button", { name: "协作消息", exact: true }).click();
  await page.getByRole("button", { name: "适应画布", exact: true }).click();
  await expect(page.locator(".agent-collaboration .agent-event-broadcast")).toHaveCount(1);
  await page.getByLabel("筛选参与者").selectOption(b.id);
  await expect(page.locator(".agent-collaboration .agent-event-broadcast")).toContainText(
    "请共同核对时间线。",
  );
  await page.getByText("接收者与共享资源", { exact: true }).last().click();
  await page.screenshot({ path: test.info().outputPath("broadcast.png") });
});

test("彩蛋默认造型、卡片权限行与头像对比度消融", async ({ page, request }) => {
  const root = await board(request, "人物样张");
  const people = [];
  for (const [index, character] of AGENT_CAMEOS.entries())
    people.push(await agent(request, root.id, character.name, index));
  await openBoard(page, root.title);
  await expect(page.locator(`[data-node-id="${people[0].id}"]`)).toBeVisible();
  await page.getByRole("button", { name: "适应画布", exact: true }).click();
  for (const character of AGENT_CAMEOS)
    await expect(
      page.locator(`.agent-photo-card [data-character="${character.name}"]`),
    ).toHaveCount(1);
  const overlaps = await page.locator(".agent-photo-card").evaluateAll((cards) =>
    cards.map((card) => {
      const role = card.querySelector(".agent-role")!.getBoundingClientRect(),
        summary = card.querySelector("p")!.getBoundingClientRect();
      return role.bottom - summary.top;
    }),
  );
  expect(Math.max(...overlaps)).toBeLessThan(0);
  const contrast = PORTRAIT_SKINS.map((skin) => ({
    skin,
    before: colorContrast(skin, "#fff8ee"),
    after: colorContrast(skin, portraitColors(skin).nose),
  }));
  expect(Math.max(...contrast.map((c) => c.after))).toBeLessThan(2);
  expect(Math.max(...contrast.map((c) => c.before))).toBeGreaterThan(7);
  // A contact sheet of the production card DOM, with its actual SVG, for visual review.
  await page.evaluate(() => {
    const sheet = document.createElement("div");
    sheet.style.cssText =
      "display:grid;grid-template-columns:repeat(4,220px);gap:20px;padding:24px;background:#f6f3ed;width:980px";
    for (const card of Array.from(document.querySelectorAll(".agent-photo-card"))) {
      const clone = card.cloneNode(true) as HTMLElement;
      clone.style.cssText =
        "height:300px;padding:8px;background:white;border:1px solid #e3dfd6;border-radius:8px";
      sheet.appendChild(clone);
    }
    document.body.replaceChildren(sheet);
    document.body.style.overflow = "auto";
  });
  await page.setViewportSize({ width: 1000, height: 1320 });
  await page.screenshot({ path: test.info().outputPath("cameo-portraits.png"), fullPage: true });
  writeFileSync(
    test.info().outputPath("portrait-contrast.json"),
    JSON.stringify(
      { contrast, maxRoleOverlap: Math.max(...overlaps), cameos: AGENT_CAMEOS.length },
      null,
      2,
    ),
  );
});
