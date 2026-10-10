import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { API_URL, DATABASE_URL } from "./environment.mjs";

for (const language of ["zh-CN", "en"])
  test(`complete records load in place and survive refresh (${language})`, async ({
    page,
    request,
  }) => {
    const chinese = language === "zh-CN";
    const board = (
      await (
        await request.post(`${API_URL}/api/v2/canvases`, {
          data: { title: `Complete records ${randomUUID()}`, idempotencyKey: randomUUID() },
        })
      ).json()
    ).node;
    const agent = (
      await (
        await request.post(`${API_URL}/api/v2/nodes`, {
          data: {
            kind: "agent",
            parentId: board.id,
            agent: { role: "read", persona: "", enabled: false },
            position: { x: 80, y: 80, width: 220, height: 300 },
            idempotencyKey: randomUUID(),
          },
        })
      ).json()
    ).node;
    const db = new pg.Client({ connectionString: DATABASE_URL });
    await db.connect();
    try {
      const conversation = (
        await db.query("select id from intrica.conversations where agent_id=$1", [agent.id])
      ).rows[0].id;
      const rows = [
        {
          role: "inference_item",
          data: {
            itemKind: "thinking",
            state: "committed",
            text: "",
            thinking: `${"context ".repeat(500)}THINKING_TAIL`,
          },
        },
        { role: "assistant", data: { text: `${"paragraph ".repeat(500)}BODY_TAIL` } },
        {
          role: "tool",
          data: {
            callId: "large-output",
            name: "bash",
            status: "complete",
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ output: `${"output ".repeat(4000)}OUTPUT_TAIL` }),
                },
              ],
            },
          },
        },
        {
          role: "inference_item",
          data: {
            itemKind: "thinking",
            state: "discarded",
            thinking: "Interrupted diagnostic record",
          },
        },
      ];
      for (let i = 0; i < rows.length; i++)
        await db.query(
          "insert into intrica.messages(conversation_id,seq,client_message_id,role,content) values($1,$2,$3,$4,$5)",
          [conversation, i + 1, randomUUID(), rows[i]!.role, JSON.stringify(rows[i]!.data)],
        );
      await db.query(
        "update intrica.conversations set message_seq=4,consumed_message_seq=4 where id=$1",
        [conversation],
      );
      const serverId = (await (await request.get(`${API_URL}/api/v2/server`)).json()).id;
      await page.addInitScript(
        ({ serverId, id, language }) => {
          localStorage.setItem(`intrica:server:${serverId}:intrica:canvas`, id);
          localStorage.setItem("intrica:language", language);
        },
        { serverId, id: board.id, language },
      );
      let thinkingLoads = 0;
      await page.route(`**/api/v2/canvas-agents/${agent.id}/events/1`, async (route) => {
        thinkingLoads++;
        if (thinkingLoads === 1)
          await route.fulfill({
            status: 503,
            json: { error: { code: "UNAVAILABLE", message: "temporary record failure" } },
          });
        else await route.continue();
      });
      await page.goto("/");
      await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
      const thought = page.locator('.agent-event[data-message-seq="1"]');
      const body = page.locator('.agent-event[data-message-seq="2"]');
      const tool = page.locator('.agent-event[data-message-seq="3"]');
      await expect(thought).toBeVisible();
      await expect(thought.locator("summary")).toContainText(
        chinese ? "已加入模型上下文" : "Added to model context",
      );
      await expect(page.locator('.agent-event[data-message-seq="4"] summary')).toContainText(
        chinese ? "已中断 · 仅保留记录" : "Interrupted · diagnostic record only",
      );
      await expect(page.getByRole("button", { name: /展开完整记录|Show full record/ })).toHaveCount(
        0,
      );
      await expect(thought.getByRole("button", { name: /阅读全文|Read full text/ })).toHaveCount(0);
      await thought.locator("summary").press("Enter");
      await expect(thought.getByRole("alert")).toBeVisible();
      await thought
        .getByRole("button", { name: chinese ? "重试" : "Retry", exact: true })
        .press("Enter");
      await expect(thought).toContainText("THINKING_TAIL");
      await body
        .getByRole("button", { name: chinese ? "阅读全文" : "Read full text", exact: true })
        .press("Enter");
      await expect(body).toContainText("BODY_TAIL");
      await tool.locator(":scope > details > summary").press("Enter");
      const more = tool.getByRole("button", {
        name: chinese ? "显示更多内容" : "Show more content",
        exact: true,
      });
      await expect(more).toBeVisible();
      await more.press("Enter");
      await more.press("Enter");
      await expect(tool).toContainText("OUTPUT_TAIL");
      const refreshed = page.waitForResponse(
        (response) => new URL(response.url()).pathname === `/api/v2/canvas-agents/${agent.id}`,
      );
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await refreshed;
      await expect(thought).toContainText("THINKING_TAIL");
      await expect(thought.locator("details")).toHaveAttribute("open");
      await expect(body).toContainText("BODY_TAIL");
      expect(thinkingLoads).toBe(2);
      await db.query("update intrica.messages set content=$3 where conversation_id=$1 and seq=$2", [
        conversation,
        1,
        JSON.stringify({
          itemKind: "thinking",
          state: "committed",
          text: "",
          thinking: `${"new context ".repeat(300)}NEW_THINKING_TAIL`,
        }),
      ]);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(thought).toContainText("NEW_THINKING_TAIL");
      expect(thinkingLoads).toBe(3);
      await page.setViewportSize({ width: 700, height: 900 });
      const separator = page.getByRole("separator", {
        name: chinese ? "调整侧栏宽度" : "Resize sidebar",
        exact: true,
      });
      for (
        let attempts = 0;
        Number(await separator.getAttribute("aria-valuenow")) > 320 && attempts < 30;
        attempts++
      )
        await separator.press("ArrowRight");
      expect((await page.locator(".workspace-panel").boundingBox())!.width).toBeCloseTo(320, 0);
      await expect(thought.locator("details")).toHaveAttribute("open");
      await expect(body).toContainText("BODY_TAIL");
      const overflow = await page
        .locator(".agent-timeline")
        .evaluate((element) =>
          [element, ...Array.from(element.querySelectorAll("summary, p, pre, button"))]
            .filter((node) => node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 2)
            .map((node) => node.className || node.tagName),
        );
      expect(overflow).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`complete-record-${language}.png`) });
      await page.reload();
      await expect(page.locator(`[data-node-id="${agent.id}"]`)).toBeVisible();
      if (!(await thought.isVisible()))
        await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
      await expect(thought.locator("summary")).toContainText(
        chinese ? "已加入模型上下文" : "Added to model context",
      );
      await thought.locator("summary").press("Enter");
      await expect(thought).toContainText("NEW_THINKING_TAIL");
      await expect(page.locator('.agent-event[data-message-seq="4"] summary')).toContainText(
        chinese ? "已中断 · 仅保留记录" : "Interrupted · diagnostic record only",
      );
    } finally {
      await db.end();
    }
  });
