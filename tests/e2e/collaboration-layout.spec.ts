import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import type { CollaborationReceipt, Node } from "@intrica/contracts";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

// Only conversation data is controlled. The canvas, Agent panel, translations,
// controls, status requests and focus behavior use the real application.
test("collaboration hierarchy, reminder actions and keyboard controls work in narrow bilingual panels", async ({
  page,
  request,
}, info) => {
  const key = () => randomUUID();
  const board = (
    await (
      await request.post(`${API_URL}/api/v2/canvases`, {
        data: { title: `UI review ${key()}`, idempotencyKey: key() },
      })
    ).json()
  ).node as Node;
  const create = async (x: number) =>
    (
      await (
        await request.post(`${API_URL}/api/v2/nodes`, {
          data: {
            kind: "agent",
            parentId: board.id,
            position: { x, y: 140, width: 220, height: 300 },
            agent: {
              role: "admin",
              persona: "协调成员，核查交付结果，并跟进需要回复的消息。",
              enabled: true,
            },
            idempotencyKey: key(),
          },
        })
      ).json()
    ).node as Node;
  const sender = await create(80),
    first = await create(460),
    second = await create(800);
  const now = new Date().toISOString();
  const receipt = (
    recipient: Node,
    patch: Partial<CollaborationReceipt> = {},
  ): CollaborationReceipt => ({
    deliveryId: `delivery-${recipient.id}`,
    recipientId: recipient.id,
    recipientName: recipient.title!,
    state: "unread",
    readAt: null,
    expectReply: true,
    replied: false,
    replyMessageId: null,
    replyConversationId: null,
    replySeq: null,
    priority: "normal",
    expeditedAt: null,
    expediteReadAt: null,
    paused: false,
    blocked: false,
    tracking: true,
    version: 3,
    ...patch,
  });
  const notices = [
    {
      deliveryId: `delivery-${first.id}`,
      recipientName: first.title,
      state: "open",
      version: 3,
      readAt: now,
      pending: true,
      expectReply: true,
      tracking_stopped: false,
      paused: false,
      blocked: false,
      message: "请核对这一版动画的帧数和循环设置，完成后回复结论。",
      snoozedUntil: null as string | null,
    },
    {
      deliveryId: `delivery-${second.id}`,
      recipientName: second.title,
      state: "open",
      version: 5,
      readAt: null,
      pending: true,
      expectReply: true,
      tracking_stopped: false,
      paused: true,
      blocked: false,
      message: "请查看页面的窄屏布局，重点检查长文件名和操作按钮。",
      snoozedUntil: null as string | null,
    },
  ];
  const actions: Array<{ id: string; action: string; version: number; waitSeconds?: number }> = [];
  await page.route(`**/api/v2/canvas-agents/${sender.id}*`, async (route) => {
    if (new URL(route.request().url()).pathname !== `/api/v2/canvas-agents/${sender.id}`)
      return route.continue();
    const response = await route.fetch(),
      base = await response.json();
    const shared = {
      senderId: sender.id,
      senderName: sender.title,
      recipientNames: { [first.id]: first.title, [second.id]: second.title },
    };
    const row = (seq: number, kind: string, data: object) => ({
      seq,
      kind,
      agentId: sender.id,
      conversationId: base.conversationId,
      createdAt: now,
      data: { ...shared, ...data },
    });
    await route.fulfill({
      response,
      json: {
        ...base,
        events: [
          row(0, "user", {
            text: "请开始本轮检查。",
            inputReceipt: { messageId: "input-fixture", state: "unread", expeditedAt: now },
          }),
          row(1, "message", {
            recipients: [first.id],
            text: "新版预览已准备好，请优先检查动画循环。",
            priority: "expedited",
            deliveryReceipts: [receipt(first, { priority: "expedited", expeditedAt: now })],
          }),
          row(2, "broadcast", {
            recipients: [first.id, second.id],
            text: "本轮先完成视觉检查，再汇总需要修改的项目。",
            deliveryReceipts: [
              receipt(first, { state: "read", readAt: now, expectReply: false, tracking: false }),
              receipt(second, { expectReply: false }),
            ],
          }),
          row(3, "message_notice", {
            text: "Internal reminder payload",
            deliveries: notices.map((n) => ({ deliveryId: n.deliveryId, event: "reply_overdue" })),
          }),
        ],
      },
    });
  });
  await page.route("**/api/v2/message-deliveries**", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: notices });
    const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const body = route.request().postDataJSON();
    actions.push({ id, ...body });
    const target = notices.find((n) => n.deliveryId === id)!;
    target.version++;
    if (body.action === "wait")
      target.snoozedUntil = new Date(Date.now() + body.waitSeconds * 1000).toISOString();
    if (body.action === "cancel") {
      target.pending = false;
      target.tracking_stopped = true;
    }
    await route.fulfill({ json: { changed: true } });
  });
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: board.title!, exact: true }).click();
  for (const language of ["zh-CN", "en"]) {
    await page.evaluate((language) => localStorage.setItem("intrica:language", language), language);
    await page.reload();
    await page.locator(`[data-node-id="${sender.id}"]`).dblclick();
    const panel = page.locator(".agent-inspector"),
      notice = panel.locator(".message-notice-actions");
    await expect(notice).toContainText(
      language === "zh-CN" ? "消息需要跟进" : "Messages need follow-up",
    );
    await expect(panel).not.toContainText("Internal reminder payload");
    const urgent = panel.locator(".agent-event-message");
    await expect(urgent.locator(".input-expedite")).toHaveCount(1);
    await expect(
      urgent.getByRole("button", {
        name: language === "zh-CN" ? "加急消息" : "Expedite message",
        exact: true,
      }),
    ).toHaveCount(0);
    const broadcast = panel.locator(".delivery-receipt-summary");
    await broadcast.focus();
    await broadcast.press("Enter");
    await expect(panel.locator(".delivery-receipt-summary")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
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
      const indicatorGeometry = await panel
        .locator(".agent-event-user,.agent-event-message")
        .evaluateAll((elements) =>
          elements.map((el) => {
            const bubble = el.getBoundingClientRect();
            const read = el
              .querySelector(".input-receipt .receipt-status")!
              .getBoundingClientRect();
            const priority = el.querySelector(".input-expedite")!.getBoundingClientRect();
            return {
              right: bubble.right - read.right,
              bottom: bubble.bottom - read.bottom,
              readWidth: read.width,
              readHeight: read.height,
              left: priority.left - bubble.left,
              top: priority.top - bubble.top,
              priorityWidth: priority.width,
              priorityHeight: priority.height,
            };
          }),
        );
      expect(indicatorGeometry).toHaveLength(2);
      for (const metric of [
        "right",
        "bottom",
        "readWidth",
        "readHeight",
        "left",
        "top",
        "priorityWidth",
        "priorityHeight",
      ] as const)
        expect(
          Math.abs(indicatorGeometry[0]![metric] - indicatorGeometry[1]![metric]),
          metric,
        ).toBeLessThanOrEqual(1.1);
      await notice.scrollIntoViewIfNeeded();
      expect(
        await panel
          .locator(".agent-event,.collaboration-state")
          .evaluateAll((elements) => elements.every((el) => el.scrollWidth - el.clientWidth <= 1)),
      ).toBe(true);
      const controls = await notice.locator("button,select,summary").evaluateAll((elements) =>
        elements
          .filter((e) => e.getClientRects().length)
          .map((e) => {
            const r = e.getBoundingClientRect();
            const hit = getComputedStyle(e, "::after");
            const extra = e.classList.contains("input-expedite")
              ? Math.max(0, -parseFloat(hit.left)) * 2
              : 0;
            return { width: r.width + extra, height: r.height + extra };
          }),
      );
      expect(controls.every((r) => r.width >= 24 && r.height >= 24)).toBe(true);
      await panel.screenshot({ path: info.outputPath(`collaboration-${language}-${width}.png`) });
      const audit = await new AxeBuilder({ page })
        .include(".message-notice-actions")
        .include(".collaboration-state")
        .include(".delivery-receipts")
        .include(".input-expedite")
        .withRules([
          "color-contrast",
          "button-name",
          "label",
          "aria-valid-attr-value",
          "aria-allowed-attr",
        ])
        .analyze();
      expect(audit.violations).toEqual([]);
    }
    if (language === "zh-CN") {
      await notice.getByLabel("下次提醒").selectOption("300");
      const firstNotice = notice.locator(".message-notice-list > li").first();
      await firstNotice.getByRole("button", { name: "继续等待", exact: true }).click();
      await expect(firstNotice).toContainText("已延后提醒");
      expect(actions[0]).toEqual({
        id: notices[0]!.deliveryId,
        action: "wait",
        version: 3,
        waitSeconds: 300,
      });
      const secondNotice = notice.locator(".message-notice-list > li").nth(1);
      await expect(secondNotice.getByRole("button", { name: "加急消息", exact: true })).toHaveCount(
        0,
      );
      await expect(secondNotice.getByRole("button", { name: "停止跟踪", exact: true })).toHaveCount(
        0,
      );
      await secondNotice.locator("summary").focus();
      await secondNotice.locator("summary").press("Enter");
      await secondNotice.getByRole("button", { name: "停止跟踪", exact: true }).click();
      await expect(secondNotice.getByRole("status", { name: "已停止跟踪" })).toBeVisible();
      expect(actions[1]).toEqual({ id: notices[1]!.deliveryId, action: "cancel", version: 5 });
    }
  }
});
