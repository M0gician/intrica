import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { API_URL, DATABASE_URL } from "./environment.mjs";
import { ablateHistory, visualAblations } from "./experiments/visual-ablations";

const api = API_URL;
test("长历史按页卸载、旧检查点直达、窄画布顶栏与输入区对齐", async ({ page, request }) => {
  await page.setViewportSize({ width: 1512, height: 951 });
  const canvas = (
    await (
      await request.post(`${api}/api/v2/canvases`, {
        data: { title: "长会话性能测试", idempotencyKey: randomUUID() },
      })
    ).json()
  ).node;
  const agent = (
    await (
      await request.post(`${api}/api/v2/nodes`, {
        data: {
          kind: "agent",
          parentId: canvas.id,
          title: "长程开发工程师",
          position: { x: 40, y: 170, width: 220, height: 300 },
          agent: { persona: "验证长会话", role: "write", enabled: false },
          idempotencyKey: randomUUID(),
        },
      })
    ).json()
  ).node;
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    await db.query(
      `insert into intrica.messages(conversation_id,seq,client_message_id,role,content)
      select (select id from intrica.conversations where agent_id=$1),i+1,'fixture-'||i,case when i%40=0 then 'user' else 'assistant' end,
      jsonb_build_object('text','checkpoint-'||i||': '||repeat('long record ',500)||'END_OF_LONG_RECORD','thinking',repeat('thought ',1500))
      from generate_series(0,2499) i`,
      [agent.id],
    );
    await db.query("update intrica.conversations set message_seq=2500 where agent_id=$1", [
      agent.id,
    ]);
  } finally {
    await db.end();
  }
  const serverId = (await (await request.get(`${API_URL}/api/v2/server`)).json()).id;
  await page.addInitScript(
    ({ id, serverId }) => localStorage.setItem(`intrica:server:${serverId}:intrica:canvas`, id),
    { id: canvas.id, serverId },
  );
  await page.goto("/");
  await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
  await expect(page.locator(".agent-event")).toHaveCount(80);
  await expect(page.locator(".agent-event details p")).toHaveCount(0);
  await page.locator('.message-rail [data-anchor-key="1"]').click();
  await expect(page.locator(".agent-event")).toHaveCount(80);
  await expect(page.locator(".agent-activity")).toContainText("checkpoint-0:");
  await page.getByRole("button", { name: "较新会话", exact: true }).click();
  await expect(page.locator(".agent-event")).toHaveCount(80);
  await expect(page.locator(".agent-activity")).toContainText("checkpoint-80:");
  await page.getByRole("button", { name: "返回最新会话", exact: true }).click();
  await expect(page.locator(".agent-activity")).toContainText("checkpoint-2499:");
  await page.getByRole("button", { name: "阅读全文", exact: true }).last().click();
  await expect(page.locator(".agent-event").last()).toContainText("END_OF_LONG_RECORD");
  await page.getByRole("button", { name: "展开阅读宽度", exact: true }).click();
  const path = (await page.locator(".top-bar-path").boundingBox())!;
  const controls = (await page.locator(".top-bar-controls").boundingBox())!;
  expect(Math.abs(path.y + path.height / 2 - controls.y - controls.height / 2)).toBeLessThan(3);
  expect(path.x + path.width).toBeLessThanOrEqual(controls.x);
  if (visualAblations) await ablateHistory(page);
  await page.getByRole("button", { name: "模型会话", exact: true }).click();
  const toolbar = page.locator(".workspace-tool:not([hidden]) .agent-composer-toolbar");
  const box = (await toolbar.boundingBox())!;
  const ring = (await toolbar.locator(".context-usage-ring").boundingBox())!;
  const send = (await toolbar.locator(".composer-action").boundingBox())!;
  const model = (await toolbar.locator(".model-picker").boundingBox())!;
  expect(Math.abs(model.x - ring.x - ring.width)).toBeLessThan(5);
  expect(box.x + box.width - send.x - send.width).toBeLessThan(5);
  expect(await toolbar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("long-history.png") });
});
