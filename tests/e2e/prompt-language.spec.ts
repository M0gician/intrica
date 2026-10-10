import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

test("shared menu icons and prompts follow interface language without rewriting user content", async ({
  page,
  request,
}) => {
  const api = `${API_URL}/api/v2`;
  const canvas = (
    await (
      await request.post(`${api}/canvases`, {
        data: {
          title: "Language review",
          idempotencyKey: randomUUID(),
        },
      })
    ).json()
  ).node;
  const agent = (
    await (
      await request.post(`${api}/nodes`, {
        data: {
          kind: "agent",
          parentId: canvas.id,
          title: "Prompt review",
          agent: { persona: "USER_PERSONA 保留原文", role: "read", enabled: false },
          position: { x: 80, y: 80, width: 240, height: 300 },
          idempotencyKey: randomUUID(),
        },
      })
    ).json()
  ).node;
  const completeReply = async () => {
    await expect
      .poll(
        async () => (await (await request.get(`${api}/canvas-agents/${agent.id}`)).json()).runState,
      )
      .toBe("succeeded");
    const entry = page.locator(".agent-event-assistant").last();
    await expect(entry).not.toHaveAttribute("data-message-key", /:-1$/);
    const expand = entry.getByRole("button", { name: /^(阅读全文|Read full text)$/ });
    if (await expand.isVisible()) await expand.click();
    return entry;
  };
  await page.goto("/");
  await page.getByRole("button", { name: "切换画布", exact: true }).click();
  await page.getByRole("button", { name: canvas.title, exact: true }).click();
  const chevrons = await page
    .locator(".canvas-chevron svg, .top-bar .model-trigger-chevron svg")
    .evaluateAll((icons) =>
      icons.map((i) => ({ path: i.innerHTML, width: i.getBoundingClientRect().width })),
    );
  expect(chevrons.length).toBe(2);
  expect(chevrons[0]).toEqual(chevrons[1]);
  await page.getByRole("button", { name: "切换画布", exact: true }).click();
  const more = page.getByRole("button", { name: `${canvas.title}的更多操作` });
  await expect(more.locator("svg circle")).toHaveCount(3);
  await more.focus();
  await page.screenshot({ path: test.info().outputPath("canvas-menu.png") });
  await more.press("Enter");
  await expect(page.getByRole("menuitem", { name: "重命名", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
  await page.getByLabel("Agent 任务").fill("用户内容 stays unchanged");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".agent-event-assistant").last()).toContainText(
    "你是 Intrica 画布 Agent",
  );
  await expect(await completeReply()).toContainText("USER_PERSONA 保留原文");
  await expect(page.getByRole("button", { name: /^(切换画布|Switch canvas)$/ })).toBeVisible();
  await page.keyboard.press("Control+,");
  const settings = page.getByRole("main", { name: "设置", exact: true });
  await settings.getByLabel("语言", { exact: true }).selectOption("en");
  await page
    .getByRole("main", { name: "Settings", exact: true })
    .getByRole("button", { name: "Back to canvas", exact: true })
    .click();
  const task = page.getByLabel("Agent task", { exact: true });
  await task.fill("Keep the task unchanged.");
  const sent = page.waitForRequest(
    (r) => r.url().endsWith(`/canvas-agents/${agent.id}/run`) && r.method() === "POST",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  expect((await sent).headers()["accept-language"]).toBe("en");
  await expect(page.locator(".agent-event-assistant").last()).toContainText(
    /You are the Intrica canvas agent/i,
  );
  await expect(await completeReply()).toContainText("USER_PERSONA 保留原文");
  await expect(page.locator(".agent-event-assistant").last()).not.toContainText("你是 Intrica");
});
