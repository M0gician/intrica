import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { API_URL, DATABASE_URL } from "./environment.mjs";

const scenarios: Array<{
  title: string;
  rows: number;
  user: number[];
  incoming: number[];
  milestones?: boolean;
}> = [
  { title: "Manager history", rows: 144, user: [1, 69, 83], incoming: [35, 120] },
  { title: "Design history", rows: 9, user: [], incoming: [1] },
  { title: "Animation history", rows: 130, user: [96], incoming: [1, 40] },
  { title: "QA history", rows: 45, user: [], incoming: [1, 20] },
  { title: "Motion QA history", rows: 67, user: [], incoming: [1, 30] },
  { title: "Task-only history", rows: 120, user: [], incoming: [1], milestones: false },
];

for (const scenario of scenarios) {
  test(`navigates ${scenario.title} with sparse human input`, async ({ page, request }) => {
    const canvas = (
      await (
        await request.post(`${API_URL}/api/v2/canvases`, {
          data: { title: scenario.title, idempotencyKey: randomUUID() },
        })
      ).json()
    ).node;
    const agent = (
      await (
        await request.post(`${API_URL}/api/v2/nodes`, {
          data: {
            kind: "agent",
            parentId: canvas.id,
            title: scenario.title,
            agent: { persona: "Read existing history", role: "read", enabled: false },
            position: { x: 30, y: 80, width: 220, height: 300 },
            idempotencyKey: randomUUID(),
          },
        })
      ).json()
    ).node;
    const db = new pg.Client({ connectionString: DATABASE_URL });
    await db.connect();
    let conversation: string;
    try {
      conversation = (
        await db.query("select id from intrica.conversations where agent_id=$1", [agent.id])
      ).rows[0].id;
      await db.query(
        `insert into intrica.messages(conversation_id,seq,client_message_id,role,content)
         select $1,i,'coordination-'||i,
           case when i=any($3::int[]) then 'user' when i=any($4::int[]) then 'message'
                when $5::boolean and i=$2-1 then 'report'
                when $5::boolean and i=$2 then 'run_status' else 'assistant' end,
           jsonb_build_object('text',case when i=any($4::int[]) then 'Incoming task '||i
             when $5::boolean and i=$2-1 then 'Verified report'
             when $5::boolean and i=$2 then 'The run needs attention'
             else 'Record '||i||': '||repeat('Long conversation text. ',120) end)
           || case when i=any($4::int[]) then '{"from":"manager-fixture"}'::jsonb
              when $5::boolean and i=$2 then '{"category":"failed"}'::jsonb else '{}'::jsonb end
         from generate_series(1,$2::int) i`,
        [
          conversation,
          scenario.rows,
          scenario.user,
          scenario.incoming,
          scenario.milestones !== false,
        ],
      );
      await db.query(
        "update intrica.conversations set message_seq=$2,consumed_message_seq=$2 where id=$1",
        [conversation, scenario.rows],
      );
    } finally {
      await db.end();
    }
    const serverId = (await (await request.get(`${API_URL}/api/v2/server`)).json()).id;
    await page.addInitScript(
      ({ serverId, canvas }) => {
        localStorage.setItem(`intrica:server:${serverId}:intrica:canvas`, canvas);
      },
      { serverId, canvas: canvas.id },
    );
    await page.setViewportSize({ width: 1512, height: 951 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
    const rail = page.getByRole("navigation", { name: "会话导航", exact: true });
    const anchors = [
      ...scenario.user,
      ...scenario.incoming,
      ...(scenario.milestones !== false ? [scenario.rows - 1, scenario.rows] : []),
    ].sort((a, b) => a - b);
    await expect(rail.locator("button")).toHaveCount(anchors.length);
    expect(scenario.user.length >= 4).toBe(false);
    let bodyReads = 0;
    page.on("request", (req) => {
      if (new URL(req.url()).pathname === `/api/v2/canvas-agents/${agent.id}`) bodyReads++;
    });
    const first = rail.locator('[data-anchor-key="1"]');
    await first.hover();
    const preview = page.getByRole("dialog", { name: "会话预览", exact: true });
    await expect(preview).toContainText(scenario.user.includes(1) ? "Record 1" : "Incoming task 1");
    expect(bodyReads).toBe(0);
    await first.click();
    await expect(page.locator('.agent-event[data-message-seq="1"]')).toBeInViewport();
    expect(await page.locator(".agent-event").count()).toBeLessThanOrEqual(80);
    if (scenario.milestones !== false) {
      await rail.locator(`[data-anchor-key="${scenario.rows}"]`).hover();
      await expect(preview).toContainText("运行状态");
      await expect(preview).toContainText("The run needs attention");
      await rail.locator(`[data-anchor-key="${scenario.rows}"]`).click();
      await expect(
        page.locator(`.agent-event[data-message-seq="${scenario.rows}"]`),
      ).toBeInViewport();
      await expect(rail).toBeVisible();
    }
    await first.click();
    await expect(page.locator('.agent-event[data-message-seq="1"]')).toBeInViewport();
    await test.info().attach("navigation-coverage", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          rows: scenario.rows,
          userAnchors: scenario.user.length,
          interactionAnchors: anchors.length,
          fourUserThreshold: false,
          historicalTarget: 1,
          boundedDomRows: await page.locator(".agent-event").count(),
        }),
      ),
    });
  });
}
