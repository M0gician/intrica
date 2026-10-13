import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import type { Node } from "@intrica/contracts";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

test("Agent identity moves into the collaboration bar as the profile leaves view", async ({
  page,
  request,
}, info) => {
  const board = (
    await (
      await request.post(`${API_URL}/api/v2/canvases`, {
        data: { title: `Identity ${randomUUID()}`, idempotencyKey: randomUUID() },
      })
    ).json()
  ).node as Node;
  const create = async (title: string, x: number) =>
    (
      await (
        await request.post(`${API_URL}/api/v2/nodes`, {
          data: {
            kind: "agent",
            parentId: board.id,
            title,
            position: { x, y: 140, width: 220, height: 300 },
            agent: { persona: "协调成员并核查交付结果。", role: "admin", enabled: true },
            idempotencyKey: randomUUID(),
          },
        })
      ).json()
    ).node as Node;
  const owner = await create("梁溪 · 研究与交付协调负责人", 80);
  const member = await create("林真", 460);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`**/api/v2/canvas-agents/${owner.id}*`, async (route) => {
    if (new URL(route.request().url()).pathname !== `/api/v2/canvas-agents/${owner.id}`)
      return route.continue();
    const response = await route.fetch();
    const base = await response.json();
    const row = (seq: number, kind: string, data: object) => ({
      seq,
      kind,
      agentId: owner.id,
      conversationId: base.conversationId,
      createdAt: new Date().toISOString(),
      data,
    });
    await route.fulfill({
      response,
      json: {
        ...base,
        events: [
          row(1, "message", { from: member.id, text: "检查结果已准备好。" }),
          row(2, "message", { recipients: [member.id], text: "请继续核对布局。" }),
          row(3, "tool", { name: "review_inbox", status: "complete" }),
          ...Array.from({ length: 16 }, (_, i) =>
            row(i + 4, "assistant", {
              thinking: "检查当前任务与协作消息。",
              text: `检查记录 ${i + 1}：确认各项结果与待处理请求。`,
            }),
          ),
        ],
      },
    });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: board.title!, exact: true }).click();
  for (const language of ["zh-CN", "en"]) {
    await page.evaluate((value) => localStorage.setItem("intrica:language", value), language);
    await page.reload();
    await page.locator(`[data-node-id="${owner.id}"]`).dblclick();
    const panel = page.locator(".agent-inspector");
    const bar = panel.locator(".collaboration-state");
    const scroller = panel.locator(".agent-timeline-scroll");
    const name = bar.locator(".collaboration-state-name");
    const status = language === "zh-CN" ? "自动协作已开启" : "Automatic collaboration active";
    const toggle = bar.getByRole("button", {
      name: language === "zh-CN" ? "暂停协作" : "Pause collaboration",
      exact: true,
    });
    // Opening a conversation follows the latest records and already needs its compact identity.
    await expect(name).toHaveText(owner.title!);
    await expect(bar.getByRole("status")).toHaveText(status);
    await expect(panel.locator(".agent-activity .activity-participants strong")).toHaveText(
      member.title!,
    );
    const variant = await panel
      .locator(".agent-profile .agent-portrait")
      .getAttribute("data-portrait-variant");
    await expect(bar.locator(".agent-portrait")).toHaveAttribute("data-portrait-variant", variant!);
    for (const width of [480, 320]) {
      const handle = page.getByRole("separator", { name: /调整侧栏宽度|Resize sidebar/ });
      const box = (await handle.boundingBox())!;
      const startX = box.x + box.width / 2;
      const currentWidth = Number(await handle.getAttribute("aria-valuenow"));
      await page.mouse.move(startX, box.y + 150);
      await page.mouse.down();
      await page.mouse.move(startX + currentWidth - width, box.y + 150);
      await page.mouse.up();
      await expect(handle).toHaveAttribute("aria-valuenow", String(width));
      await expect(name).toHaveText(owner.title!);
      expect(
        await bar
          .locator(".collaboration-state-label > span:last-child")
          .evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(1);
      const compactButton = (await toggle.boundingBox())!;
      const compactBar = (await bar.boundingBox())!;
      await panel.screenshot({ path: info.outputPath(`identity-${language}-${width}.png`) });
      expect(await bar.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      await scroller.evaluate((el) => {
        el.scrollTop = 0;
      });
      await expect(name).toHaveCount(0);
      await expect(bar.locator(".agent-portrait")).toHaveCount(0);
      await expect(bar.getByRole("status")).toHaveText(status);
      const topButton = (await toggle.boundingBox())!;
      expect(Math.abs(topButton.x - compactButton.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(topButton.y - compactButton.y)).toBeLessThanOrEqual(1);
      expect(Math.abs((await bar.boundingBox())!.height - compactBar.height)).toBeLessThanOrEqual(
        1,
      );
      await panel.screenshot({ path: info.outputPath(`profile-${language}-${width}.png`) });
      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect(name).toHaveText(owner.title!);
      await expect(bar.getByRole("status")).toHaveText(status);
    }
    const audit = await new AxeBuilder({ page })
      .include(".collaboration-state")
      .withRules(["color-contrast", "button-name", "aria-valid-attr-value", "aria-allowed-attr"])
      .analyze();
    expect(audit.violations).toEqual([]);
    // Pausing keeps the participant visible and the control usable after the identity transition.
    await toggle.focus();
    await toggle.press("Enter");
    await expect(bar.getByRole("status")).toHaveText(
      language === "zh-CN" ? "协作已暂停" : "Collaboration paused",
    );
    await expect(name).toHaveText(owner.title!);
    await bar
      .getByRole("button", {
        name: language === "zh-CN" ? "恢复协作" : "Resume collaboration",
        exact: true,
      })
      .press("Enter");
    await expect(bar.getByRole("status")).toHaveText(status);
  }
  expect(errors).toEqual([]);
});
