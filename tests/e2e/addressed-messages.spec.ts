import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

test("explicit replies, private notes and task selection remain clear in a narrow panel", async ({
  page,
  request,
}) => {
  const board = (
    await (
      await request.post(`${API_URL}/api/v2/canvases`, {
        data: { title: "Message routing", idempotencyKey: randomUUID() },
      })
    ).json()
  ).node;
  const agent = (
    await (
      await request.post(`${API_URL}/api/v2/nodes`, {
        data: {
          kind: "agent",
          parentId: board.id,
          title: "林舟",
          agent: { role: "read", persona: "核对证据", enabled: false },
          position: { x: 140, y: 140, width: 220, height: 300 },
          idempotencyKey: randomUUID(),
        },
      })
    ).json()
  ).node;
  const conversationId = randomUUID(),
    requestId = randomUUID();
  const messageRequests = [
    {
      id: requestId,
      direction: "incoming",
      senderKind: "user",
      recipientKind: "agent",
      senderName: "user",
      recipientName: agent.title,
      senderConversationId: conversationId,
      recipientConversationId: conversationId,
      state: "open",
      workState: "waiting",
      blockedReason: "reply_required",
      summary: "核对两份资料",
      replyMessageId: null,
      originWorkItemId: null,
      parentRequestId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
  await page.route(`**/api/v2/canvas-agents/${agent.id}*`, (route) => {
    if (new URL(route.request().url()).pathname !== `/api/v2/canvas-agents/${agent.id}`)
      return route.continue();
    return route.fulfill({
      json: {
        conversationId,
        messageRequests,
        requests: [],
        running: false,
        interrupted: false,
        runState: "waiting",
        runReason: "reply_required",
        lastEventSeq: "0",
        events: [
          {
            seq: 1,
            kind: "user",
            data: {
              text: "核对两份资料",
              messageRequests,
              inputReceipt: { state: "read", messageId: "input" },
            },
          },
          { seq: 2, kind: "model_output", data: { text: "UNCLASSIFIED_DRAFT" } },
          { seq: 3, kind: "internal_note", data: { text: "PRIVATE_NOTE_BODY" } },
          {
            seq: 4,
            kind: "output_error",
            data: { text: "UNPUBLISHED_BODY", reason: "消息缺少目标" },
          },
          {
            seq: 5,
            kind: "assistant",
            data: {
              text: "已核对第一份资料",
              recipients: ["user"],
              messageRequests,
              inReplyTo: requestId,
            },
          },
        ].map((e) => ({ ...e, agentId: agent.id, conversationId })),
      },
    });
  });
  const sent: any[] = [];
  await page.route(`**/api/v2/canvas-agents/${agent.id}/run`, (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ status: 202, json: { started: true } });
  });
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: board.title, exact: true }).click();
  await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
  await expect(page.getByText("UNCLASSIFIED_DRAFT")).toHaveCount(0);
  await expect(page.getByText("PRIVATE_NOTE_BODY")).not.toBeVisible();
  await expect(page.getByText("UNPUBLISHED_BODY")).not.toBeVisible();
  await expect(page.locator(".agent-event-assistant")).toContainText("用户");
  await page.getByText("内部笔记 · 未发送", { exact: true }).click();
  await expect(page.getByText("PRIVATE_NOTE_BODY")).toBeVisible();
  await page.getByLabel("输入归属").selectOption(`append:${requestId}`);
  await page.getByRole("textbox", { name: "Agent 任务", exact: true }).fill("补充一条证据");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].association).toEqual({ kind: "append", requestId });
  await page
    .locator(".workspace-panel")
    .evaluate((el) => ((el as HTMLElement).style.width = "320px"));
  const sizes = await page
    .locator(".agent-node-panel")
    .evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.width + 1);
  const associationBox = await page.getByLabel("输入归属").boundingBox();
  const inputBox = await page
    .getByRole("textbox", { name: "Agent 任务", exact: true })
    .boundingBox();
  expect(inputBox!.y).toBeGreaterThanOrEqual(associationBox!.y + associationBox!.height);
  expect(inputBox!.width).toBeGreaterThan(250);
  await page.screenshot({ path: test.info().outputPath("addressed-messages.png") });
});
