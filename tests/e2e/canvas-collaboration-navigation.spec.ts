import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { API_URL, DATABASE_URL } from "./environment.mjs";

test("collaboration rail locates cross-conversation history and keeps filters, previews and bookmarks aligned", async ({
  page,
  request,
}) => {
  const board = (
    await (
      await request.post(`${API_URL}/api/v2/canvases`, {
        data: { title: "Collaboration navigation", idempotencyKey: randomUUID() },
      })
    ).json()
  ).node;
  const agent = async (title: string, parentId = board.id) => {
    const response = await request.post(`${API_URL}/api/v2/nodes`, {
      data: {
        kind: "agent",
        parentId,
        title,
        position: { x: 0, y: 0, width: 220, height: 300 },
        agent: { role: "read", persona: "Read history", enabled: false },
        idempotencyKey: randomUUID(),
      },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()).node;
  };
  const manager = await agent("Manager"),
    member = await agent("Member", manager.id),
    outsider = await agent("Other team");
  const artifact = (
    await (
      await request.post(`${API_URL}/api/v2/nodes`, {
        data: {
          kind: "text",
          parentId: board.id,
          title: "Verified output",
          text: "Saved result",
          position: { x: 600, y: 200, width: 220, height: 160 },
          idempotencyKey: randomUUID(),
        },
      })
    ).json()
  ).node;
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  const ids: string[] = [];
  try {
    for (const [index, node] of [manager, member, outsider].entries()) {
      const conversationId = (
        await db.query("select id from intrica.conversations where agent_id=$1", [node.id])
      ).rows[0].id;
      ids.push(conversationId);
      await db.query(
        `insert into intrica.messages(conversation_id,seq,client_message_id,role,content,created_at)
        select $1,i,'collaboration-'||i,'message',jsonb_build_object('text',$2||' message '||i||': '||repeat('Historical collaboration. ',120),'senderId',$3::text,'recipients',jsonb_build_array($4::text)),
        '2026-01-01'::timestamptz+i*interval '1 second'
        from generate_series(1,260) i`,
        [
          conversationId,
          node.title,
          node.id,
          index === 0 ? member.id : index === 1 ? manager.id : outsider.id,
        ],
      );
      await db.query(
        "update intrica.conversations set message_seq=260,consumed_message_seq=260 where id=$1",
        [conversationId],
      );
    }
    await db.query(
      "update intrica.messages set role='report',content=content||jsonb_build_object('resourceIds',jsonb_build_array($2::text)) where conversation_id=$1 and seq=1",
      [ids[0], artifact.id],
    );
  } finally {
    await db.end();
  }
  const base = `${API_URL}/api/v2/canvas-activity`,
    query = `canvasId=${board.id}`;
  const indexPage = await (await request.get(`${base}/navigation?${query}`)).json();
  expect(indexPage.items).toHaveLength(512);
  const rest = await (
    await request.get(
      `${base}/navigation?${query}&after=${encodeURIComponent(indexPage.nextAfter)}`,
    )
  ).json();
  const keys = [...indexPage.items, ...rest.items] as string[];
  expect(new Set(keys).size).toBe(780);
  expect(rest.nextAfter).toBeNull();
  const firstManager = `${ids[0]}:1`,
    firstMember = `${ids[1]}:1`;
  const previewData = await (
    await request.get(`${base}/navigation/${encodeURIComponent(firstManager)}?${query}`)
  ).json();
  expect(previewData.title).toBe("Manager → Member");
  expect(previewData.excerpt.length).toBeLessThanOrEqual(240);
  expect(previewData.artifacts).toEqual({
    items: [{ id: artifact.id, label: "Verified output" }],
    total: 1,
  });
  const filtered = await (
    await request.get(`${base}/navigation?${query}&groupId=${manager.id}`)
  ).json();
  expect(filtered.items.every((key: string) => !key.startsWith(`${ids[2]}:`))).toBe(true);
  const selected = await (
    await request.get(`${base}/navigation?${query}&selection=${member.id}`)
  ).json();
  expect(selected.items).toEqual(filtered.items);
  expect(
    (
      await request.get(
        `${base}/navigation/${encodeURIComponent(`${ids[2]}:1`)}?${query}&groupId=${manager.id}`,
      )
    ).status(),
  ).toBe(404);
  expect(
    (
      await request.get(
        `${base}?${query}&groupId=${manager.id}&around=${encodeURIComponent(`${ids[2]}:1`)}`,
      )
    ).status(),
  ).toBe(404);
  expect(
    (
      await request.get(
        `${base}/navigation/${encodeURIComponent(firstManager)}?canvasId=canvas-e2e`,
      )
    ).status(),
  ).toBe(404);
  const server = await (await request.get(`${API_URL}/api/v2/server`)).json();
  await page.addInitScript(
    ({ server, canvasId }) =>
      localStorage.setItem(`intrica:server:${server}:intrica:canvas`, canvasId),
    { server: server.id, canvasId: board.id },
  );
  await page.setViewportSize({ width: 1512, height: 951 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
  await page.getByRole("button", { name: "协作消息", exact: true }).click();
  const panel = page.locator(".agent-collaboration"),
    rail = panel.getByRole("navigation", { name: "会话导航", exact: true });
  const tick = (key: string) => rail.locator(`[data-anchor-key="${key}"]`);
  const row = (key: string) => panel.locator(`[data-message-key="${key}"]`);
  await expect(rail.locator("button")).toHaveCount(780);
  await expect(panel.locator(".agent-event")).toHaveCount(100);
  let bodyRequests = 0;
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/v2/canvas-activity") bodyRequests++;
  });
  await tick(firstManager).hover();
  const preview = page.getByRole("dialog", { name: "会话预览", exact: true });
  await expect(preview).toContainText("Manager → Member");
  await expect(preview).toContainText("Manager message 1");
  await expect(preview.locator(".message-artifact-tag")).toHaveText("Verified output");
  expect(bodyRequests).toBe(0);
  await preview.getByRole("button", { name: "收藏记录", exact: true }).click();
  await expect(tick(firstManager)).toHaveAttribute("data-bookmarked", "true");
  const geometry = await tick(firstManager).evaluate((element) => {
    const tick = element.getBoundingClientRect(),
      popup = document.querySelector(".message-preview")!.getBoundingClientRect();
    return { gap: tick.left - popup.right, popupRight: popup.right, tickLeft: tick.left };
  });
  expect(geometry.gap).toBe(0);
  await tick(firstManager).click();
  await expect(row(firstManager)).toBeInViewport();
  await expect(row(firstManager)).toContainText("Manager message 1");
  await tick(firstMember).click();
  await expect(row(firstMember)).toBeInViewport();
  await expect(row(firstMember)).toHaveClass(/message-navigation-target/);
  const loaded = bodyRequests;
  const from = (await tick(keys[12]!).boundingBox())!,
    to = (await tick(keys[15]!).boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + 3);
  await page.mouse.down();
  await page.mouse.move(to.x + 20, to.y + 3, { steps: 4 });
  await page.mouse.up();
  expect(bodyRequests).toBe(loaded);
  await expect(row(keys[15]!)).toBeInViewport();
  let release!: () => void, started!: () => void, delivered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  const delayedKey = `${ids[2]}:200`;
  await page.route(
    (url) =>
      url.pathname === "/api/v2/canvas-activity" && url.searchParams.get("around") === delayedKey,
    async (route) => {
      const response = await route.fetch();
      started();
      await held;
      await route.fulfill({ response });
      delivered();
    },
  );
  await tick(delayedKey).click();
  await requested;
  await panel.getByLabel("选择协作团队").selectOption(manager.id);
  release();
  await finished;
  await expect(rail.locator("button")).toHaveCount(520);
  await expect(tick(firstManager)).toHaveAttribute("data-bookmarked", "true");
  await expect(panel.locator(`[data-message-key^="${ids[2]}:"]`)).toHaveCount(0);
  await tick(firstManager).click();
  await expect(row(firstManager)).toBeInViewport();
  await row(firstManager).focus();
  await page.keyboard.press("Alt+ArrowDown");
  const teamKeys = keys.filter((key) => !key.startsWith(`${ids[2]}:`));
  await expect(row(teamKeys[teamKeys.indexOf(firstManager) + 1]!)).toBeInViewport();
  await panel.getByRole("button", { name: "返回最新会话", exact: true }).click();
  await expect(row(`${ids[0]}:260`)).toBeVisible();
  await tick(firstManager).hover();
  await expect(preview).toContainText("Manager message 1");
  await page.screenshot({ path: test.info().outputPath("collaboration-right-rail.png") });
  const updates = new pg.Client({ connectionString: DATABASE_URL });
  await updates.connect();
  try {
    await updates.query(
      `insert into intrica.messages(conversation_id,seq,client_message_id,role,content,created_at)
      values($1,261,'late-message','message',jsonb_build_object('senderId',$2::text,'to',$3::text,'text','Earlier timestamp, new arrival'),'2026-01-01 00:00:00.5Z')`,
      [ids[0], manager.id, member.id],
    );
    await updates.query(
      "update intrica.conversations set message_seq=261,consumed_message_seq=261 where id=$1",
      [ids[0]],
    );
  } finally {
    await updates.end();
  }
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(rail.locator("button")).toHaveCount(521);
  await tick(`${ids[0]}:261`).click();
  await expect(row(`${ids[0]}:261`)).toBeInViewport();
  await expect(row(`${ids[0]}:261`)).toContainText("Earlier timestamp, new arrival");
  await page.reload();
  await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
  await page.getByRole("button", { name: "协作消息", exact: true }).click();
  await expect(tick(firstManager)).toHaveAttribute("data-bookmarked", "true");
  await page.setViewportSize({ width: 620, height: 900 });
  await expect(rail).toHaveCount(0);
  expect(
    await panel.locator(".agent-timeline-scroll").evaluate((e) => e.scrollWidth <= e.clientWidth),
  ).toBe(true);
});
