import { expect, test } from "@playwright/test";
import {
  prepareJourney,
  seedPendingApproval,
  verifyJourney,
  verifyPendingApproval,
} from "../fixtures/agent-journey.mjs";
import { API_URL } from "./environment.mjs";

test("实时招募可进入、布局不遮挡、按需委派完成，外层停止下属且导航不写图", async ({
  page,
  request,
}) => {
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await request.fetch(`${API_URL}/api/v2/${path}`, {
      method,
      ...(body === undefined ? {} : { data: body }),
    });
    expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
    return response.json();
  };
  const journey = await prepareJourney(call, { pauseSecondHire: true });
  try {
    await page.goto("/");
    await page.getByLabel("切换画布").click();
    await page.getByRole("button", { name: journey.board.title, exact: true }).click();
    const manager = page.locator(`[data-node-id="${journey.manager.id}"]`);
    await journey.start();
    const entry = manager.locator(".agent-team-faces");
    await expect(entry).toBeVisible();
    let writes = 0;
    await page.route("**/api/v2/graph-ops", async (route) => {
      if (route.request().method() === "POST") {
        writes++;
        await route.fulfill({ status: 503, body: "write unavailable" });
      } else await route.continue();
    });
    await entry.click();
    await expect(page.locator(".overlay-space .node-card")).toHaveCount(1);
    journey.releaseRecruitment();
    await expect(page.locator(".overlay-space .node-card")).toHaveCount(2);
    const members = await verifyJourney(call, journey);
    const boxes = await Promise.all(
      members.map((m) => page.locator(`[data-node-id="${m.id}"]`).boundingBox()),
    );
    const [a, b] = boxes;
    expect(
      a &&
        b &&
        (a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y),
    ).toBe(true);
    await page.screenshot({ path: test.info().outputPath("live-recruited-team.png") });
    await page.getByRole("button", { name: "关闭临时内部空间" }).click();
    for (const m of members) await expect(page.locator(`[data-node-id="${m.id}"]`)).toHaveCount(0);
    const before = (await call(`bootstrap?canvasId=${journey.board.id}`)).graphRevision;
    await entry.click();
    await expect(page.locator(".overlay-space")).toBeVisible();
    await page.getByRole("button", { name: "关闭临时内部空间" }).click();
    expect(writes).toBe(0);
    expect((await call(`bootstrap?canvasId=${journey.board.id}`)).graphRevision).toBe(before);
    await journey.holdMember(members[0].id);
    await journey.holding;
    await manager.click();
    await page.getByRole("button", { name: "停止选中 Agent 及其团队" }).click();
    await expect
      .poll(async () => (await call(`canvas-agents/${members[0].id}`)).runState)
      .toBe("cancelled");
    await expect(page.getByRole("button", { name: "启动选中 Agent 及其团队" })).toBeVisible();
    await page.reload();
    await expect(manager.locator(".agent-team-faces")).toBeVisible();
  } finally {
    await journey.close();
  }
});

test("自动分派在协作历史中保留身份，删除旧团队后可筛选当前团队", async ({ page, request }) => {
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await request.fetch(`${API_URL}/api/v2/${path}`, {
      method,
      ...(body === undefined ? {} : { data: body }),
    });
    expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
    return response.json();
  };
  const journey = await prepareJourney(call);
  try {
    const pending = await seedPendingApproval(call, journey);
    await verifyPendingApproval(call, journey, pending);
    await journey.start();
    const members = await verifyJourney(call, journey, [pending.request.id]);
    await page.goto("/");
    await page.getByLabel("切换画布").click();
    await page.getByRole("button", { name: journey.board.title, exact: true }).click();
    await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
    await page.getByRole("button", { name: "协作消息", exact: true }).click();
    const panel = page.locator(".agent-collaboration");
    await expect(panel.locator(".agent-event-message time").first()).toHaveCSS("opacity", "1");
    await expect(panel.locator(".agent-event-message > small").first()).toContainText(
      "Acceptance manager →",
    );
    const firstIdentity = (await panel
      .locator(".agent-event-message > small")
      .first()
      .textContent())!;
    const recipient = members.find((m: { title: string }) =>
      firstIdentity.includes(`→ ${m.title}`),
    );
    expect(recipient).toBeDefined();
    await page.screenshot({ path: test.info().outputPath("initial-task-collaboration.png") });
    await call("graph-ops", "POST", {
      kind: "delete",
      nodeIds: [journey.manager.id],
      idempotencyKey: crypto.randomUUID(),
    });
    await expect(panel.locator(".agent-event-message > small").first()).toContainText(
      `Acceptance manager（已删除） → ${recipient!.title}（已删除）`,
    );
    const manager = (
      await call("nodes", "POST", {
        kind: "agent",
        title: "当前管理员",
        parentId: journey.board.id,
        agent: { persona: "", role: "admin", enabled: false },
        position: { x: 50, y: 50, width: 220, height: 300 },
        idempotencyKey: crypto.randomUUID(),
      })
    ).node;
    await call("nodes", "POST", {
      kind: "agent",
      title: "当前成员",
      parentId: manager.id,
      agent: { persona: "", role: "read", enabled: false },
      position: { x: 30, y: 60, width: 220, height: 300 },
      idempotencyKey: crypto.randomUUID(),
    });
    await panel.getByLabel("选择协作团队").selectOption(manager.id);
    await expect(panel.locator(".agent-event")).toHaveCount(0);
    await panel.getByLabel("选择协作团队").selectOption("");
    // Each member has an initial request, a follow-up and a result in the unified message feed.
    await expect(panel.locator(".agent-event-message")).toHaveCount(members.length * 3);
  } finally {
    await journey.close();
  }
});
