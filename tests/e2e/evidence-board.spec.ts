import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { AxeBuilder } from "@axe-core/playwright";
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
test("四边连接点、恒定点击区域、工具栏延迟退场和画布入口", async ({ page, request }) => {
  const root = await board(request, "证据工作台");
  const node = (
    await (
      await request.post(`${api}/api/v2/nodes`, {
        data: {
          kind: "text",
          parentId: root.id,
          title: "证据笔记",
          text: "核查来源，记录事实。",
          position: { x: 160, y: 200, width: 240, height: 180 },
          idempotencyKey: randomUUID(),
        },
      })
    ).json()
  ).node;
  const evidence = [];
  for (const [title, text, x] of [
    ["现场记录", "时间、地点和可验证的事实。", 480],
    ["待核实的证词", "先记录说法，再寻找独立来源。", 800],
  ] as const) {
    evidence.push(
      (
        await (
          await request.post(`${api}/api/v2/nodes`, {
            data: {
              kind: "text",
              parentId: root.id,
              title,
              text,
              position: { x, y: 200, width: 240, height: 180 },
              idempotencyKey: randomUUID(),
            },
          })
        ).json()
      ).node,
    );
  }
  const researcher = (
    await (
      await request.post(`${api}/api/v2/nodes`, {
        data: {
          kind: "agent",
          parentId: root.id,
          title: "周宁",
          agent: { persona: "交叉核对证据，寻找矛盾与缺失。", role: "read", enabled: false },
          position: { x: 480, y: 440, width: 220, height: 300 },
          idempotencyKey: randomUUID(),
        },
      })
    ).json()
  ).node;
  const graph = await (await request.get(`${api}/api/v2/bootstrap`)).json();
  await request.post(`${api}/api/v2/links/batch`, {
    data: {
      fromIds: [node.id, ...evidence.map((n) => n.id)],
      toId: researcher.id,
      expectedGraphRevision: graph.graphRevision,
      idempotencyKey: randomUUID(),
    },
  });
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: "证据工作台", exact: true }).click();
  const trigger = page.getByLabel("切换画布");
  await expect(trigger).toContainText("证据工作台");
  await expect(trigger.locator(".canvas-chevron")).toHaveCount(1);
  const card = page.locator(`[data-node-id="${node.id}"]`),
    port = card.locator(".node-connect-port");
  await card.click();
  const toolbar = page.getByRole("toolbar", { name: "节点操作" });
  await expect(toolbar).toBeVisible();
  const r = (await card.boundingBox())!;
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await expect(port).toHaveCSS("opacity", "0");
  for (const [side, x, y] of [
    ["left", r.x + 2, r.y + r.height / 2],
    ["top", r.x + r.width / 2, r.y + 2],
    ["right", r.x + r.width - 2, r.y + r.height / 2],
    ["bottom", r.x + r.width / 2, r.y + r.height - 2],
  ] as const) {
    await page.mouse.move(x, y);
    await expect(port).toHaveAttribute("data-side", side);
    await expect(port).toHaveCSS("opacity", "1");
  }
  const dotWidth = (await port.locator("span").boundingBox())!.width;
  const hitWidth = (await port.boundingBox())!.width;
  expect(dotWidth).toBe(7);
  expect(hitWidth).toBe(24);
  await toolbar.hover();
  await expect(toolbar).not.toHaveClass(/is-leaving/);
  await page.mouse.move(700, 90);
  await expect(toolbar).toHaveCount(0);
  await expect(page.getByRole("toolbar", { name: "选中操作栏" })).toContainText("已选择 1 项");
  await card.click();
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole("button", { name: "查看详情", exact: true }).click();
  await page.getByRole("button", { name: "关闭详情侧栏" }).click();
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "缩小", exact: true }).click();
  const small = (await card.boundingBox())!;
  await page.mouse.move(small.x + 2, small.y + small.height / 2);
  await expect(port).toHaveCSS("opacity", "1");
  const scaledHitWidth = (await port.boundingBox())!.width;
  expect(scaledHitWidth).toBeCloseTo(24, 0);
  const withoutCompensationWidth = await port.evaluate((element) => {
    const button = element as HTMLButtonElement;
    const previous = button.style.transform;
    button.style.transform = "translate(-50%,-50%)";
    const width = button.getBoundingClientRect().width;
    button.style.transform = previous;
    return width;
  });
  expect(withoutCompensationWidth).toBeLessThan(13);
  const metrics = {
    dotWidth,
    hitWidth,
    scaledHitWidth,
    withoutCompensationWidth,
    priorFixedPortWidth: 22,
  };
  writeFileSync(
    test.info().outputPath("connection-point-measurements.json"),
    JSON.stringify(metrics, null, 2),
  );
  await page.getByRole("button", { name: "适应画布", exact: true }).click();
  await page.mouse.click(1150, 620);
  await expect(port).toHaveCSS("opacity", "0");
  await port.focus();
  await page.keyboard.press("Enter");
  const keyboardTarget = page.locator(`[data-node-id="${evidence[0].id}"]`);
  await keyboardTarget.focus();
  await expect(page.locator(".edge-user")).toHaveCount(3);
  await page.keyboard.press("Enter");
  await expect(page.locator(".edge-user")).toHaveCount(4);
  await page.mouse.click(1150, 620);
  await expect(port).toHaveCSS("opacity", "0");
  await page.screenshot({ path: test.info().outputPath("evidence-cards.png") });
});

test("Agent 自动命名、设置快速保存与失败恢复、会话收起设置", async ({ page, request }) => {
  const root = await board(request, "人物档案");
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: "人物档案", exact: true }).click();
  await page.mouse.dblclick(380, 280);
  await page.getByRole("menuitem", { name: "Agent", exact: true }).click();
  await page.getByRole("menuitem", { name: "只读", exact: true }).click();
  const name = page.getByLabel("Agent 姓名");
  await expect(name).not.toHaveValue("新 Agent");
  expect((await name.inputValue()).length).toBeGreaterThan(1);
  const snapshot = await (await request.get(`${api}/api/v2/bootstrap?canvasId=${root.id}`)).json();
  const agent = snapshot.nodes.find((n: any) => n.kind === "agent" && n.parentId === root.id);
  let first = true;
  await page.route(`**/api/v2/nodes/${agent.id}`, async (route) => {
    if (first && route.request().method() === "PATCH") {
      first = false;
      await new Promise((r) => setTimeout(r, 250));
    }
    await route.continue();
  });
  await name.fill("顾言");
  await page.getByLabel("Agent 性格与职责").fill("核查线索，并分清事实与猜测。");
  await page.getByRole("button", { name: "Agent 访问权限" }).click();
  await page.getByText("调整角色", { exact: true }).click();
  await page.getByRole("radio", { name: "读写", exact: true }).check();
  await page.getByRole("button", { name: "Agent 能力与设置" }).click();
  await page.getByRole("switch", { name: "持续协作" }).check();
  await page.keyboard.press("Escape");
  await expect(async () => {
    const s = await (await request.get(`${api}/api/v2/bootstrap?canvasId=${root.id}`)).json();
    expect(s.nodes.find((n: any) => n.id === agent.id)).toMatchObject({
      title: "顾言",
      agent: { persona: "核查线索，并分清事实与猜测。", role: "write", enabled: true },
    });
  }).toPass();
  await page.unroute(`**/api/v2/nodes/${agent.id}`);
  let fail = true;
  await page.route(`**/api/v2/nodes/${agent.id}`, async (route) => {
    if (fail && route.request().method() === "PATCH") {
      fail = false;
      await route.fulfill({
        status: 500,
        json: { error: { code: "INTERNAL", message: "测试保存失败" } },
      });
    } else await route.continue();
  });
  await page.getByLabel("Agent 性格与职责").fill("保留草稿，等待保存。");
  await name.click();
  await expect(page.getByRole("button", { name: "重试保存设置" })).toBeVisible();
  await expect(page.getByLabel("Agent 性格与职责")).toHaveValue("保留草稿，等待保存。");
  await page.getByRole("button", { name: "重试保存设置" }).click();
  await expect(page.locator(".agent-save-state")).toHaveText("已保存");
  const axe = await new AxeBuilder({ page }).include(".workspace-panel").analyze();
  expect(axe.violations.filter((v) => ["critical", "serious"].includes(v.impact ?? ""))).toEqual(
    [],
  );
  await page.screenshot({ path: test.info().outputPath("agent-settings.png") });
  fail = true;
  await name.fill("另一位顾言");
  await page.getByLabel("Agent 性格与职责").click();
  await expect(page.getByRole("alert")).toContainText("姓名保存失败");
  await name.fill("顾言");
  await page.getByLabel("Agent 任务").click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const settings = page.locator(".agent-settings-disclosure");
  const expandedHeight = (await settings.boundingBox())!.height;
  await page.getByLabel("Agent 任务").fill("说明当前职责。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(settings).not.toHaveAttribute("open");
  const collapsedHeight = (await settings.boundingBox())!.height;
  expect(expandedHeight - collapsedHeight).toBeGreaterThan(100);
  await expect(page.locator(".agent-event-user")).toContainText("说明当前职责。");
  writeFileSync(
    test.info().outputPath("settings-ablation.json"),
    JSON.stringify({ expandedHeight, collapsedHeight }, null, 2),
  );
  await page.screenshot({ path: test.info().outputPath("agent-conversation.png") });
});
