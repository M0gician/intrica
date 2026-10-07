import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

const api = API_URL;
async function createAgent(request: any, parentId: string, title: string, x = 120) {
  const response = await request.post(`${api}/api/v2/nodes`, {
    data: {
      kind: "agent",
      parentId,
      title,
      agent: { persona: "核对事实与来源。", role: "read", enabled: false },
      position: { x, y: 150, width: 220, height: 300 },
      idempotencyKey: randomUUID(),
    },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).node;
}
async function setup(page: any, request: any, title: string) {
  const board = (
    await (
      await request.post(`${api}/api/v2/canvases`, {
        data: { title, idempotencyKey: randomUUID() },
      })
    ).json()
  ).node;
  const agent = await createAgent(request, board.id, "周宁");
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: title, exact: true }).click();
  return { board, agent };
}

test("Agent 会话独立滚动、窄栏换行、动态输入框与布局消融", async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { agent } = await setup(page, request, "输入区回归");
  const events = Array.from({ length: 14 }, (_, i) => ({
    seq: i + 1,
    agentId: agent.id,
    kind: i % 2 ? "assistant" : "user",
    data: { text: `第 ${i + 1} 条消息。\n\n${"需要核查证据与来源。".repeat(25)}` },
  }));
  events.push({
    seq: 15,
    agentId: agent.id,
    kind: "assistant",
    data: {
      text: `https://example.com/${"long-path".repeat(65)}\n\n\`\`\`json\n${"longCode".repeat(100)}\n\`\`\`\n\n| 证据 | 来源 | 说明 |\n|---|---|---|\n| ${"证据".repeat(120)} | ${"source".repeat(80)} | 待查 |`,
    },
  });
  const feed: any[] = [
    ...events,
    {
      seq: 16,
      agentId: agent.id,
      kind: "tool",
      data: {
        id: "tool1",
        name: "read",
        status: "complete",
        args: { target: { kind: "node", nodeId: "node1" } },
        result: "tool-result".repeat(150),
      },
    },
    { seq: 17, agentId: agent.id, kind: "status", data: { text: "最终状态完整可见" } },
  ];
  await page.route(`**/api/v2/canvas-agents/${agent.id}*`, (route) =>
    route.fulfill({ json: { events: feed, running: false, requests: [] } }),
  );
  await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
  const scroller = page.locator(".agent-inspector .agent-timeline-scroll");
  const composer = page.locator(".agent-compose");
  const last = page.locator(".agent-event-status").last();
  const jump = page.getByRole("button", { name: "返回最新会话", exact: true });
  await expect(last).toBeVisible();
  await expect(jump).toHaveCount(0);
  const resize = page.getByRole("separator", { name: "调整侧栏宽度" });
  const metrics = [];
  for (const width of [320, 480, 920]) {
    const handle = (await resize.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 150);
    await page.mouse.down();
    await page.mouse.move(1280 - width, handle.y + 150);
    await page.mouse.up();
    await expect(async () => {
      const size = await page.locator(".workspace-panel").boundingBox();
      expect(Math.abs(size!.width - width)).toBeLessThan(3);
    }).toPass();
    await page.getByLabel("Agent 任务").fill("输入框的内容保持可见。\n".repeat(8));
    await page.getByLabel("Agent 任务").evaluate((el: HTMLTextAreaElement) => {
      el.style.height = "160px";
    });
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(jump).toBeVisible();
    const before = await scroller.evaluate((el) => el.scrollTop);
    feed.push({
      seq: feed.length + 1,
      agentId: agent.id,
      kind: "status",
      data: { text: `最新状态 ${width}` },
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(last).toHaveText(new RegExp(`最新状态 ${width}`));
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(before);
    expect((await jump.boundingBox())!.y + (await jump.boundingBox())!.height).toBeLessThan(
      (await composer.boundingBox())!.y,
    );
    await jump.click();
    await expect(jump).toHaveCount(0);
    await expect(async () => {
      const bottom = (await last.boundingBox())!;
      expect(bottom.y + bottom.height).toBeLessThanOrEqual((await composer.boundingBox())!.y);
    }).toPass();
    feed[feed.length - 1].data.text += "\n继续流式输出。".repeat(8);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(last).toContainText("继续流式输出。");
    await expect(async () => {
      const tail = (await last.boundingBox())!;
      expect(tail.y + tail.height).toBeLessThan((await composer.boundingBox())!.y);
    }).toPass();
    await page.screenshot({ path: test.info().outputPath(`agent-width-${width}.png`) });
    await page.locator(".agent-event-tool > details > summary").click();
    await expect(page.locator(".agent-event-tool pre").first()).toBeVisible();
    const overflow = await scroller.evaluate((el) =>
      [el, ...Array.from(el.querySelectorAll(".agent-event, pre, table"))].map(
        (n) => n.scrollWidth - n.clientWidth,
      ),
    );
    expect(Math.max(...overflow)).toBeLessThanOrEqual(2);
    metrics.push({ width, overflow: Math.max(...overflow) });
    await page.locator(".agent-event-tool > details > summary").click();
  }
  // Remove the wrapping rule, then remove reserved composer space, measuring each regression.
  await page.locator(".agent-event-tool > details > summary").click();
  await expect(page.locator(".agent-event-tool pre").first()).toBeVisible();
  const unwrapped = await page.addStyleTag({
    content: ".agent-event pre {white-space: pre; overflow-wrap: normal;}",
  });
  const withoutWrapping = await page
    .locator(".agent-event pre")
    .evaluateAll((els) => Math.max(...els.map((el) => el.scrollWidth - el.clientWidth)));
  expect(withoutWrapping).toBeGreaterThan(100);
  await unwrapped.evaluate((el) => el.parentNode?.removeChild(el));
  const overlay = await page.addStyleTag({
    content:
      ".agent-node-panel {position:relative;} .agent-node-panel .agent-compose {position:absolute;bottom:0;left:0;right:0;}",
  });
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const overlap =
    (await last.boundingBox())!.y +
    (await last.boundingBox())!.height -
    (await composer.boundingBox())!.y;
  expect(overlap).toBeGreaterThan(100);
  await overlay.evaluate((el) => el.parentNode?.removeChild(el));
  await expect(async () =>
    expect((await last.boundingBox())!.y + (await last.boundingBox())!.height).toBeLessThan(
      (await composer.boundingBox())!.y,
    ),
  ).toPass();
  writeFileSync(
    test.info().outputPath("composer-ablation.json"),
    JSON.stringify({ metrics, withoutWrapping, overlap }, null, 2),
  );
  await page.screenshot({ path: test.info().outputPath("agent-composer.png") });
});

test("输入区权限、能力入口与肖像重新生成保存", async ({ page, request }) => {
  const { agent, board } = await setup(page, request, "肖像与能力");
  const other = await createAgent(request, board.id, "林舟", 450);
  expect(other.agent.portraitVariant).not.toBe(agent.agent.portraitVariant);
  await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
  const portrait = page.locator(".agent-profile .agent-portrait");
  await page.getByRole("button", { name: "重新生成肖像" }).click();
  await expect(portrait).not.toHaveAttribute(
    "data-portrait-variant",
    String(agent.agent.portraitVariant),
  );
  await expect
    .poll(
      async () =>
        (
          await (await request.get(`${api}/api/v2/bootstrap?canvasId=${board.id}`)).json()
        ).nodes.find((n: any) => n.id === agent.id).agent.portraitVariant,
    )
    .not.toBe(agent.agent.portraitVariant);
  const variant = await portrait.getAttribute("data-portrait-variant");
  expect(variant).not.toBe(String(other.agent.portraitVariant));
  await page.getByRole("button", { name: "Agent 访问权限" }).click();
  await page.getByText("调整角色", { exact: true }).click();
  await page.getByRole("radio", { name: "读写", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Agent 访问权限", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Agent 访问权限" })).toContainText("读写");
  await page.getByRole("button", { name: "Agent 能力与设置" }).click();
  await page.getByRole("switch", { name: "持续协作" }).check();
  await page.getByText("可用工具", { exact: true }).click();
  await expect(page.getByText("网页搜索", { exact: true })).toBeVisible();
  const axe = await new AxeBuilder({ page })
    .include(".workspace-panel")
    .include(".agent-composer-popover")
    .analyze();
  expect(axe.violations.filter((v) => ["critical", "serious"].includes(v.impact ?? ""))).toEqual(
    [],
  );
  await page.screenshot({ path: test.info().outputPath("agent-capabilities.png") });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Agent 能力与设置" })).toHaveCount(0);
  await expect(page.getByLabel("Agent 任务")).toBeVisible();
  await page.getByRole("button", { name: "Agent 能力与设置" }).click();
  await page.getByRole("button", { name: "性格与职责 编辑 ↗" }).click();
  await expect(page.getByLabel("Agent 性格与职责")).toBeFocused();
  await page.reload();
  await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
  await expect(portrait).toHaveAttribute("data-portrait-variant", variant!);
  await expect(page.getByRole("button", { name: "Agent 访问权限" })).toContainText("读写");
  // Upload remains available; regenerating replaces the uploaded picture without deleting its asset.
  await page.getByLabel("Agent 肖像图片").setInputFiles({
    name: "portrait.png",
    mimeType: "image/png",
    buffer: await portrait.screenshot(),
  });
  await expect(page.locator(".agent-profile img.agent-portrait")).toBeVisible();
  await page.getByRole("button", { name: "重新生成肖像" }).click();
  await expect(page.locator(".agent-profile svg.agent-portrait")).toBeVisible();
  await expect(portrait).not.toHaveAttribute("data-portrait-variant", variant!);
});

test("有效权限按需打开，长资源列表不改变历史位置或输入区布局", async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  const { agent, board } = await setup(page, request, "有效权限布局回归");
  const events = Array.from({ length: 24 }, (_, index) => ({
    seq: index + 1,
    agentId: agent.id,
    kind: index % 2 ? "assistant" : "user",
    data: { text: `历史消息 ${index + 1}。\n\n${"保留正在阅读的会话位置。".repeat(30)}` },
  }));
  events.push({
    seq: 25,
    agentId: agent.id,
    kind: "status",
    data: { text: "权限检查前的最新状态" },
  });
  const resources = Array.from({ length: 200 }, (_, index) => ({
    nodeId: `resource-${index}`,
    rootId: `root-${index}`,
    title: `资料 ${index + 1}：${"very-long-resource-name-without-spaces-".repeat(8)}`,
    mode: "read",
    sourceLinkId: `grant-${index}`,
    delegatedBy: null,
  }));
  let permissionRequests = 0;
  let displayedResources = resources;
  await page.route(
    (url) => url.pathname === `/api/v2/canvas-agents/${agent.id}`,
    (route) => route.fulfill({ json: { events, running: false, requests: [] } }),
  );
  await page.route(
    (url) => url.pathname === `/api/v2/canvas-agents/${agent.id}/permissions`,
    (route) => {
      permissionRequests++;
      return route.fulfill({
        json: {
          role: "read",
          resources: displayedResources,
          totalResources: displayedResources.length,
        },
      });
    },
  );
  await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
  await expect(page.getByText("权限检查前的最新状态", { exact: true })).toBeVisible();
  const history = page.locator(".agent-inspector .agent-timeline-scroll");
  const composer = page.locator(".agent-compose");
  const shield = page.getByRole("button", { name: "Agent 访问权限", exact: true });
  const dialog = page.getByRole("dialog", { name: "Agent 访问权限", exact: true });
  const region = dialog.getByRole("region", { name: "当前有效权限", exact: true });
  const resize = page.getByRole("separator", { name: "调整侧栏宽度" });
  // content-visibility replaces off-screen message height estimates as they render.
  // Preserve the reading position and viewport, not the transcript's estimated scrollHeight.
  const readHistory = () =>
    history.evaluate((element) => ({
      top: element.scrollTop,
      height: element.clientHeight,
      width: element.clientWidth,
      viewportTop: element.getBoundingClientRect().top,
    }));
  expect(permissionRequests).toBe(0);
  await expect(region).toHaveCount(0);

  for (const width of [320, 480]) {
    const handle = (await resize.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
    await page.mouse.down();
    await page.mouse.move(1280 - width, handle.y + 100);
    await page.mouse.up();
    await expect(async () => {
      expect(
        Math.abs((await page.locator(".workspace-panel").boundingBox())!.width - width),
      ).toBeLessThan(3);
    }).toPass();
    await history.evaluate((element) => {
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
    });
    await expect(page.getByRole("button", { name: "返回最新会话", exact: true })).toBeVisible();
    const historyBefore = await readHistory();
    expect(
      await shield.locator("span").evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getClientRects().length;
      }),
    ).toBe(1);
    const composerBefore = await composer.boundingBox();
    const canvasBefore = await page.locator(".canvas-world").getAttribute("style");
    const requestsBefore = permissionRequests;
    await shield.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("周宁", { exact: true })).toBeVisible();
    await expect(region.getByRole("listitem")).toHaveCount(200);
    await expect.poll(() => permissionRequests).toBe(requestsBefore + 1);
    await expect.poll(readHistory).toEqual(historyBefore);
    expect(await composer.boundingBox()).toEqual(composerBefore);
    await expect(async () => {
      const bounds = (await dialog.boundingBox())!;
      const header = (await page.locator(".workspace-panel .panel-header").boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(header.y + header.height);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(1280);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(560);
    }).toPass();
    const horizontalOverflow = await dialog.evaluate((element) =>
      Math.max(
        ...[element, ...Array.from(element.querySelectorAll("section, ul, li"))].map(
          (item) => item.scrollWidth - item.clientWidth,
        ),
      ),
    );
    expect(horizontalOverflow).toBeLessThanOrEqual(2);
    for (const label of ["关闭权限", "刷新权限"]) {
      const button = dialog.getByRole("button", { name: label, exact: true });
      await button.hover();
      const caption = button.locator(".icon-caption");
      await expect(caption).toHaveCSS("opacity", "1");
      expect(
        await caption.evaluate((element) => element.scrollWidth - element.clientWidth),
      ).toBeLessThanOrEqual(1);
      expect(
        await caption.evaluate((element) => element.scrollHeight - element.clientHeight),
      ).toBeLessThanOrEqual(1);
      const bounds = (await caption.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(1280);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(560);
    }
    await dialog.locator(".agent-permissions-header strong").hover();
    await page.screenshot({ path: test.info().outputPath(`effective-permissions-${width}.png`) });
    await dialog.hover();
    await page.mouse.wheel(0, 700);
    await expect
      .poll(() =>
        dialog.evaluate((element) =>
          Math.max(
            ...[element, ...Array.from(element.querySelectorAll("*"))].map(
              (item) => item.scrollTop,
            ),
          ),
        ),
      )
      .toBeGreaterThan(0);
    await dialog.evaluate((element) => {
      for (const item of [element, ...Array.from(element.querySelectorAll("*"))]) {
        if (item.scrollHeight > item.clientHeight) item.scrollTop = item.scrollHeight;
      }
    });
    await page.mouse.wheel(0, 700);
    await expect.poll(readHistory).toEqual(historyBefore);
    expect(await page.locator(".canvas-world").getAttribute("style")).toBe(canvasBefore);
    expect(await composer.boundingBox()).toEqual(composerBefore);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(shield).toBeFocused();
    await expect.poll(readHistory).toEqual(historyBefore);
    expect(await composer.boundingBox()).toEqual(composerBefore);
  }

  displayedResources = resources.slice(0, 3).map((resource, index) => ({
    ...resource,
    title: ["项目说明", "设计素材目录", "验收记录"][index]!,
  }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await shield.click();
  await expect(region.getByRole("listitem")).toHaveCount(3);
  await page.screenshot({ path: test.info().outputPath("effective-permissions-overview.png") });
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "详情", exact: true }).click();
  await expect(shield).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await shield.click();
  await dialog.getByText("调整角色", { exact: true }).click();
  await dialog.getByRole("radio", { name: "读写", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(shield).toContainText("读写");
  await expect
    .poll(async () => {
      const response = await request.get(`${api}/api/v2/bootstrap?canvasId=${board.id}`);
      return (await response.json()).nodes.find((node: any) => node.id === agent.id).agent.role;
    })
    .toBe("write");
});
