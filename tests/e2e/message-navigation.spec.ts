import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { API_URL, DATABASE_URL } from "./environment.mjs";

test("conversation rail separates previews, history, bookmarks and pointer scrubbing", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const canvas = (
    await (
      await request.post(`${API_URL}/api/v2/canvases`, {
        data: { title: "Message navigation", idempotencyKey: randomUUID() },
      })
    ).json()
  ).node;
  const agent = (
    await (
      await request.post(`${API_URL}/api/v2/nodes`, {
        data: {
          kind: "agent",
          parentId: canvas.id,
          title: "Navigation agent",
          agent: { persona: "Read history", role: "read", enabled: false },
          position: { x: 30, y: 80, width: 220, height: 300 },
          idempotencyKey: randomUUID(),
        },
      })
    ).json()
  ).node;
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  const conversation = (
    await db.query("select id from intrica.conversations where agent_id=$1", [agent.id])
  ).rows[0].id;
  const workspace = `workspace-navigation-${randomUUID()}`;
  try {
    await db.query(
      `insert into intrica.messages(conversation_id,seq,client_message_id,role,content)
      select $1,i,'navigation-'||i,case when (i-1)%5=0 then 'user' when (i-1)%5=2 then 'message' else 'assistant' end,
        jsonb_build_object('text',case when (i-1)%5=0 then 'Question '||((i-1)/5+1)||': '||repeat('question ',60)
          else 'Reply '||((i-1)/5+1)||': '||repeat('answer ',350) end)
      from generate_series(1,5500) i`,
      [conversation],
    );
    await db.query("update intrica.conversations set message_seq=5500 where id=$1", [conversation]);
    const runId = `navigation-run-${randomUUID()}`,
      attemptId = `navigation-attempt-${randomUUID()}`;
    await db.query(
      "insert into intrica.runs(id,canvas_id,subject_id,cause_id,kind,state,frozen_input) values($1,$2,$3,$1,'conversation','succeeded','{}')",
      [runId, canvas.id, conversation],
    );
    await db.query(
      "insert into intrica.attempts(id,run_id,epoch,state) values($1,$2,1,'succeeded')",
      [attemptId, runId],
    );
    for (const seq of [3, 4, 5]) {
      const callId = `navigation-tool-${randomUUID()}`;
      await db.query(
        "insert into intrica.tool_calls(id,run_id,attempt_id,logical_call_id,name,args,args_hash,effect_class,state) values($1,$2,$3,$1,'create_artifact',$4,'test','graph','succeeded')",
        [callId, runId, attemptId, JSON.stringify({ title: `Artifact ${seq - 2}` })],
      );
      await db.query(
        "update intrica.messages set role='tool',run_id=$3,content=$4 where conversation_id=$1 and seq=$2",
        [
          conversation,
          seq,
          runId,
          JSON.stringify({ callId, name: "create_artifact", status: "complete" }),
        ],
      );
    }
    await db.query(
      "update intrica.messages set content=jsonb_set(content,'{text}',to_jsonb('Reply 1: ![remote](https://preview.invalid/picture.png) '||repeat('answer ',350))) where conversation_id=$1 and seq=2",
      [conversation],
    );
    await db.query("insert into intrica.conversations(id,canvas_id) values($1,$2)", [
      workspace,
      canvas.id,
    ]);
    await db.query(
      `insert into intrica.messages(conversation_id,seq,client_message_id,role,content)
      select $1,i,'workspace-'||i,case when i%2=1 then 'user' else 'assistant' end,
        jsonb_build_object('text',case when i%2=1 then 'Workspace question '||i else 'Workspace answer '||i end)
      from generate_series(1,200) i`,
      [workspace],
    );
    await db.query("update intrica.conversations set message_seq=200 where id=$1", [workspace]);
  } finally {
    await db.end();
  }
  const serverId = (await (await request.get(`${API_URL}/api/v2/server`)).json()).id;
  await page.addInitScript(
    ({ canvas, serverId, workspace }) => {
      localStorage.setItem(`intrica:server:${serverId}:intrica:canvas`, canvas);
      localStorage.setItem(
        `intrica:server:${serverId}:intrica:conversation:${serverId}:${canvas}`,
        workspace,
      );
    },
    { canvas: canvas.id, serverId, workspace },
  );
  let feeds = 0;
  const previews: string[] = [];
  const indices: number[] = [];
  const externalResources: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/api/v2/canvas-agents/${agent.id}`) feeds++;
    if (url.pathname.startsWith(`/api/v2/conversations/${conversation}/navigation/`))
      previews.push(url.pathname);
    if (url.hostname === "preview.invalid") externalResources.push(url.href);
  });
  page.on("response", async (response) => {
    if (new URL(response.url()).pathname === `/api/v2/conversations/${conversation}/navigation`)
      indices.push((await response.body()).length);
  });
  await page.setViewportSize({ width: 1512, height: 951 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("https://preview.invalid/**", (route) => route.abort());
  await page.goto("/");
  await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
  const rail = page.getByRole("navigation", { name: "会话导航", exact: true });
  await expect(rail.locator("button")).toHaveCount(1100);
  await expect(page.locator(".agent-event")).toHaveCount(80);
  const scroller = page.locator(".agent-timeline-scroll");
  const first = rail.locator('[data-anchor-key="1"]');
  const scrollTop = await scroller.evaluate((element) => element.scrollTop);
  const beforeHover = feeds;
  await first.hover();
  const preview = page.getByRole("dialog", { name: "会话预览", exact: true });
  await expect(preview).toContainText("Question 1:");
  await expect(preview).toContainText("Reply 1:");
  await expect(preview.locator(".message-artifact-tag")).toHaveText([
    "Artifact 1",
    "Artifact 2",
    "+1",
  ]);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(scrollTop);
  expect(feeds).toBe(beforeHover);
  expect(previews).toHaveLength(1);
  const previewReply = await (
    await request.get(`${API_URL}/api/v2/conversations/${conversation}/navigation/1`)
  ).json();
  expect(previewReply.title.length).toBeLessThanOrEqual(240);
  expect(previewReply.excerpt.length).toBeLessThanOrEqual(240);
  const firstPage = await (
    await request.get(`${API_URL}/api/v2/conversations/${conversation}/navigation`)
  ).json();
  expect(firstPage.items).toHaveLength(512);
  expect(firstPage.items.every((seq: number) => (seq - 1) % 5 === 0)).toBe(true);
  await expect(preview.locator("img, video, iframe")).toHaveCount(0);
  expect(externalResources).toHaveLength(0);
  await preview.getByRole("button", { name: "收藏记录", exact: true }).click();
  await expect(first).toHaveAttribute("data-bookmarked", "true");
  await page.mouse.move(200, 200);
  await page.waitForTimeout(160);
  await expect(preview.getByRole("button", { name: "取消收藏记录", exact: true })).toBeFocused();
  await preview.getByRole("button", { name: "取消收藏记录", exact: true }).press("Escape");
  await expect(first).toBeFocused();
  await expect(preview).toHaveCount(0);
  await first.hover();
  await expect(preview).toContainText("Question 1:");
  expect(previews).toHaveLength(1);
  await first.click();
  const target = page.locator('.agent-event[data-message-seq="1"]');
  await expect(target).toBeInViewport();
  await expect(target).toHaveClass(/message-navigation-target/);
  await expect(page.locator('.agent-event[data-message-seq="2"]')).toContainText("Reply 1:");
  await expect(rail.locator('[aria-current="location"]')).not.toHaveCount(0);
  await expect(preview).toContainText("Reply 1:");
  await page.screenshot({ path: test.info().outputPath("user-message-preview.png") });
  const measurePosition = async () => {
    await rail.locator('[data-anchor-key="5496"]').click();
    await expect(page.locator('.agent-event[data-message-seq="5496"]')).toBeVisible();
    await first.click();
    await expect(target).toBeVisible();
    await rail.locator('[data-anchor-key="51"]').click();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    return page.locator('.agent-event[data-message-seq="51"]').evaluate((element) => {
      const root = element.closest(".agent-timeline-scroll")!;
      return element.getBoundingClientRect().top - root.getBoundingClientRect().top;
    });
  };
  const boundedOffset = await measurePosition();
  const skippedStyle = await page.addStyleTag({
    content: ".agent-event {content-visibility:auto;contain-intrinsic-size:auto 100px}",
  });
  const skippedOffset = await measurePosition();
  await skippedStyle.evaluate((element) => element.parentNode!.removeChild(element));
  const restoredOffset = await measurePosition();
  expect(Math.abs(boundedOffset - 16)).toBeLessThan(2);
  expect(Math.abs(restoredOffset - 16)).toBeLessThan(2);
  await rail.locator('[data-anchor-key="51"]').hover();
  await expect(preview).toContainText("Question 11:");
  const geometry = await rail.evaluate((element) => {
    const ticks = Array.from(element.querySelectorAll<HTMLButtonElement>("button")).slice(6, 15);
    const markers = ticks.map((tick) => tick.querySelector("span")!.getBoundingClientRect());
    const tick = ticks[4]!.getBoundingClientRect();
    const popup = document.querySelector(".message-preview")!.getBoundingClientRect();
    const transcript = element.closest(".agent-timeline")!;
    const scrollport = transcript.querySelector<HTMLElement>(".agent-timeline-scroll")!;
    const content = transcript.querySelector(".agent-timeline-content")!;
    return {
      right: markers.map((marker) => marker.right),
      widths: markers.map((marker) => marker.width),
      step: ticks[1]!.getBoundingClientRect().top - ticks[0]!.getBoundingClientRect().top,
      popupWidth: popup.width,
      popupCenterOffset: popup.top + popup.height / 2 - tick.top - tick.height / 2,
      popupGap: tick.left - popup.right,
      railRightGap:
        scrollport.getBoundingClientRect().left +
        scrollport.clientLeft +
        scrollport.clientWidth -
        element.getBoundingClientRect().right,
      paddingLeft: getComputedStyle(content).paddingLeft,
      paddingRight: getComputedStyle(content).paddingRight,
    };
  });
  expect(new Set(geometry.right).size).toBe(1);
  geometry.widths.forEach((width, index) => {
    expect(width).toBeCloseTo([6, 10, 14, 20, 26, 20, 14, 10, 6][index]!, 1);
  });
  expect(geometry.step).toBe(10);
  expect(geometry.popupWidth).toBe(320);
  expect(Math.abs(geometry.popupCenterOffset)).toBeLessThan(1);
  expect(geometry.popupGap).toBe(0);
  expect(geometry.railRightGap).toBe(12);
  expect(geometry.paddingLeft).toBe("20px");
  expect(geometry.paddingRight).toBe("64px");
  for (const gutter of [0, 16]) {
    const scrollbar = await page.addStyleTag({
      content: `.agent-timeline-scroll::-webkit-scrollbar { width: ${gutter}px; }`,
    });
    await expect
      .poll(() =>
        rail.evaluate((element) => {
          const shell = element.closest(".agent-timeline")!;
          const body = shell.querySelector<HTMLElement>(".agent-timeline-scroll")!;
          return {
            gutter: body.offsetWidth - body.clientWidth,
            gap:
              body.getBoundingClientRect().left +
              body.clientLeft +
              body.clientWidth -
              element.getBoundingClientRect().right,
          };
        }),
      )
      .toEqual({ gutter, gap: 12 });
    await scrollbar.evaluate((element) => element.parentNode!.removeChild(element));
  }
  let releaseHistory!: () => void;
  let historyReady!: () => void;
  const heldHistory = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  const historyRequested = new Promise<void>((resolve) => {
    historyReady = resolve;
  });
  await page.route(`**/canvas-agents/${agent.id}?*around=501`, async (route) => {
    const response = await route.fetch();
    historyReady();
    await heldHistory;
    await route.fulfill({ response });
  });
  await rail.locator('[data-anchor-key="501"]').click();
  await historyRequested;
  await rail.locator('[data-anchor-key="6"]').click();
  const staleResponse = page.waitForResponse(
    (response) => new URL(response.url()).searchParams.get("around") === "501",
  );
  releaseHistory();
  await staleResponse;
  await expect(page.locator('.agent-event[data-message-seq="6"]')).toBeInViewport();
  await expect(page.locator('.agent-event[data-message-seq="501"]')).toHaveCount(0);
  await rail.locator('[data-anchor-key="6"]').hover();
  await expect(preview).toContainText("Question 2:");
  const loadedFeeds = feeds;
  const loadedPreviews = previews.length;
  const start = (await rail.locator('[data-anchor-key="6"]').boundingBox())!;
  const middle = (await rail.locator('[data-anchor-key="26"]').boundingBox())!;
  const end = (await rail.locator('[data-anchor-key="51"]').boundingBox())!;
  await page.mouse.move(start.x + 15, start.y + 3);
  await page.mouse.down();
  await page.mouse.move(middle.x + 15, middle.y + 3, { steps: 5 });
  // Stay beyond the 150 ms preview delay while the pointer is held down.
  await page.waitForTimeout(200);
  await page.mouse.move(end.x + 15, end.y + 3, { steps: 10 });
  expect(previews).toHaveLength(loadedPreviews);
  await page.mouse.up();
  expect(feeds).toBe(loadedFeeds);
  await expect(page.locator('.agent-event[data-message-seq="51"]')).toBeInViewport();
  await page.getByRole("button", { name: "返回最新会话", exact: true }).click();
  await expect(page.locator('.agent-event[data-message-seq="5500"]')).toBeVisible();
  await scroller.click({ position: { x: 150, y: 100 } });
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page.locator('.agent-event[data-message-seq="5496"]')).toBeInViewport();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page.locator('.agent-event[data-message-seq="5491"]')).toBeInViewport();
  await page.reload();
  await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
  await expect(first).toHaveAttribute("data-bookmarked", "true");
  await first.hover();
  await expect(preview).toContainText("Question 1:");
  await preview.getByRole("button", { name: "取消收藏记录", exact: true }).click();
  await expect(first).toHaveAttribute("data-bookmarked", "false");
  await preview.getByRole("button", { name: "收藏记录", exact: true }).click();
  const fixtureDb = new pg.Client({ connectionString: DATABASE_URL });
  await fixtureDb.connect();
  try {
    await fixtureDb.query("delete from intrica.messages where conversation_id=$1 and seq=101", [
      conversation,
    ]);
  } finally {
    await fixtureDb.end();
  }
  await rail.locator('[data-anchor-key="101"]').hover();
  await expect(preview).toContainText("预览不可用");
  await first.hover();
  await expect(preview).toContainText("Question 1:");
  await preview.getByRole("button", { name: "取消收藏记录", exact: true }).press("Escape");
  const rendering = await page.evaluate(async () => {
    const rail = document.querySelector<HTMLElement>(".message-rail-track")!;
    const groups = Array.from(rail.querySelectorAll<HTMLElement>(".message-rail-group"));
    groups.forEach((group) => {
      group.style.height = `${group.querySelectorAll("button").length * 10}px`;
    });
    const initialScroll = rail.scrollTop;
    const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
    const measure = async (visibility: string) => {
      groups.forEach((group) => {
        group.style.contentVisibility = visibility;
      });
      const samples = [];
      let previous = await frame();
      for (let step = 0; step < 70; step++) {
        rail.scrollTop = (step * 97) % (rail.scrollHeight - rail.clientHeight);
        const now = await frame();
        if (step > 9) samples.push(now - previous);
        previous = now;
      }
      samples.sort((a, b) => a - b);
      return {
        medianMs: samples[Math.floor(samples.length / 2)],
        p95Ms: samples[Math.floor(samples.length * 0.95)],
      };
    };
    const automatic = await measure("auto");
    const visible = await measure("visible");
    groups.forEach((group) => {
      group.style.contentVisibility = "";
      group.style.height = "";
    });
    rail.scrollTop = initialScroll;
    return {
      automatic,
      visible,
      ticks: rail.querySelectorAll("button").length,
      groups: groups.length,
    };
  });
  await page.setViewportSize({ width: 620, height: 900 });
  await expect(rail).toHaveCount(0);
  expect(await scroller.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  await page.setViewportSize({ width: 1512, height: 951 });
  await page.getByRole("button", { name: "展开阅读宽度", exact: true }).click();
  await page.getByRole("button", { name: "模型会话", exact: true }).click();
  await expect(rail.locator("button")).toHaveCount(100);
  await rail.locator('[data-anchor-key="1"]').hover();
  await expect(preview).toContainText("Workspace question 1");
  await expect(preview.getByRole("button", { name: "收藏记录", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await rail.locator('[data-anchor-key="1"]').click();
  await expect(page.locator('.chat-turn[data-message-seq="1"]')).toBeInViewport();
  await expect(page.locator(".chat-turn")).toHaveCount(40);
  let releaseWorkspace!: () => void;
  let workspaceReady!: () => void;
  let workspaceDelivered!: () => void;
  const heldWorkspace = new Promise<void>((resolve) => {
    releaseWorkspace = resolve;
  });
  const workspaceRequested = new Promise<void>((resolve) => {
    workspaceReady = resolve;
  });
  const workspaceFinished = new Promise<void>((resolve) => {
    workspaceDelivered = resolve;
  });
  await page.route(`**/conversations/${workspace}/messages?around=181`, async (route) => {
    const response = await route.fetch();
    workspaceReady();
    await heldWorkspace;
    await route.fulfill({ response });
    workspaceDelivered();
  });
  await rail.locator('[data-anchor-key="181"]').click();
  await workspaceRequested;
  const cancelled = page.waitForEvent("requestfailed", {
    predicate: (request) => new URL(request.url()).searchParams.get("around") === "181",
  });
  await rail.locator('[data-anchor-key="1"]').click();
  await cancelled;
  releaseWorkspace();
  await workspaceFinished;
  await expect(page.locator('.chat-turn[data-message-seq="1"]')).toBeInViewport();
  await expect(page.locator('.chat-turn[data-message-seq="181"]')).toHaveCount(0);
  await page.getByRole("button", { name: "返回最新会话", exact: true }).click();
  await expect(page.locator('.chat-turn[data-message-seq="199"]')).toBeVisible();
  await page.keyboard.press("Control+,");
  await page
    .getByRole("main", { name: "设置", exact: true })
    .getByLabel("语言", { exact: true })
    .selectOption("en");
  await page.getByRole("button", { name: "Back to canvas", exact: true }).click();
  await expect(
    page
      .getByRole("navigation", { name: "Conversation navigation", exact: true })
      .getByRole("button", { name: "Jump to conversation entry 1", exact: true }),
  ).toHaveCount(1);
  const results = {
    messageLayout: { boundedOffset, skippedOffset, restoredOffset },
    geometry,
    rendering,
    network: { indexBytes: indices, previews: previews.length, feeds },
  };
  writeFileSync(
    test.info().outputPath("navigation-validation.json"),
    JSON.stringify(results, null, 2),
  );
});
