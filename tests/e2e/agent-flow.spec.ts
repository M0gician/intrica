import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

const api = API_URL;
test("已处理申请保留原历史位置；统一按钮发送、追加、停止和继续", async ({ page, request }) => {
  const board = (
    await (
      await request.post(`${api}/api/v2/canvases`, {
        data: { title: "Agent 流程验收", idempotencyKey: randomUUID() },
      })
    ).json()
  ).node;
  const agent = (
    await (
      await request.post(`${api}/api/v2/nodes`, {
        data: {
          kind: "agent",
          parentId: board.id,
          title: "林舟",
          agent: { role: "read", persona: "核对资料", enabled: false },
          position: { x: 140, y: 140, width: 220, height: 300 },
          idempotencyKey: randomUUID(),
        },
      })
    ).json()
  ).node;
  const access = {
    toolCallId: null,
    version: 1,
    decidedBy: null,
    decisionReason: null,
    routeReason: "user",
    expiresAt: "2099-01-01T00:00:00Z",
    reviewDueAt: null,
    executionState: null,
    kind: "host",
    scope: "once",
    summary: { tool: "bash" },
    allowedActions: ["approve", "deny"],
    id: "old-access",
    agentId: agent.id,
    nodeId: agent.id,
    mode: "execute",
    reason: "较早命令",
    status: "approved",
    reviewerId: null,
    decision: "用户批准",
    action: { kind: "host", tool: "bash", args: { command: "git log --oneline -5" } },
  };
  const requests: any[] = [access];
  let running = false;
  let seq = 84;
  const rows: any[] = [
    ...Array.from({ length: 80 }, (_, i) => ({
      seq: i + 3,
      agentId: agent.id,
      kind: "assistant",
      data: { text: `后续会话 ${i}` },
    })),
    { seq: 83, agentId: agent.id, kind: "error", data: { text: "测试中断" } },
  ];
  await page.route(`**/api/v2/canvas-agents/${agent.id}*`, (r) => {
    const url = new URL(r.request().url());
    if (url.pathname !== `/api/v2/canvas-agents/${agent.id}`) return r.continue();
    const history = [
      { seq: 1, agentId: agent.id, kind: "user", data: { text: "原始任务" } },
      {
        seq: 2,
        agentId: agent.id,
        kind: "access",
        data: { requestId: access.id, nodeId: agent.id },
      },
      ...rows,
    ];
    const before = Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER);
    const events = history.filter((event) => event.seq < before).slice(-80);
    return r.fulfill({
      json: {
        events,
        nextBefore: events[0].seq > 1 ? events[0].seq : null,
        nextAfter: events.at(-1).seq < history.at(-1).seq ? events.at(-1).seq : null,
        running,
        interrupted: !running,
        requests,
      },
    });
  });
  const sent: string[] = [];
  await page.route(`**/api/v2/canvas-agents/${agent.id}/run`, (r) => {
    running = true;
    const text = r.request().postDataJSON().message;
    sent.push(text);
    rows.push({ seq: ++seq, agentId: agent.id, kind: "user", data: { text } });
    return r.fulfill({ status: 202, json: { started: true } });
  });
  await page.route(`**/api/v2/canvas-agents/${agent.id}/stop`, (r) => {
    running = false;
    rows.push({
      seq: ++seq,
      agentId: agent.id,
      kind: "status",
      data: { reason: "user", text: "已停止" },
    });
    return r.fulfill({ json: { stopped: true } });
  });
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: board.title, exact: true }).click();
  await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
  await expect(page.getByRole("button", { name: "继续", exact: true })).toBeVisible();
  await expect(page.locator(".agent-access-card")).toHaveCount(0);
  await page.getByRole("button", { name: "加载更早会话" }).click();
  const card = page.locator(".agent-access-card");
  await expect(card).toHaveCount(1);
  await expect(card.locator(":scope > details")).not.toHaveAttribute("open");
  await card.scrollIntoViewIfNeeded();
  const collapsed = (await card.boundingBox())!.height;
  const aligned = await card.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const title = el.querySelector(".access-summary-title")!.getBoundingClientRect();
    const state = el.querySelector(".access-summary-state")!.getBoundingClientRect();
    return {
      title: Math.abs(title.y + title.height / 2 - (box.y + box.height / 2)),
      state: Math.abs(state.y + state.height / 2 - (box.y + box.height / 2)),
    };
  });
  expect(aligned.title).toBeLessThanOrEqual(1);
  expect(aligned.state).toBeLessThanOrEqual(1);
  await card.locator(":scope > details > summary").click();
  const expanded = (await card.boundingBox())!.height;
  expect(collapsed).toBeLessThan(80);
  expect(expanded).toBeGreaterThan(collapsed + 60);
  await card.locator(":scope > details > summary").click();
  await page.screenshot({ path: test.info().outputPath("approval-history.png") });
  writeFileSync(
    test.info().outputPath("flow-measurements.json"),
    `${JSON.stringify(
      {
        collapsedApprovalHeight: collapsed,
        expandedApprovalHeight: expanded,
        visibleComposerActions: await page.locator(".composer-action:visible").count(),
      },
      null,
      2,
    )}\n`,
  );

  expect(
    await card.evaluate((el) => {
      const row = el.closest("article")!;
      return !!row.nextElementSibling;
    }),
  ).toBe(true);
  await expect(page.locator(".composer-action:visible")).toHaveCount(1);
  await page.getByLabel("Agent 任务").fill("新的要求");
  await page
    .locator(".agent-compose")
    .screenshot({ path: test.info().outputPath("action-send.png") });
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  await page
    .locator(".agent-compose")
    .screenshot({ path: test.info().outputPath("action-stop.png") });
  await page.getByLabel("Agent 任务").fill("追加说明");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  expect(sent).toEqual(["新的要求", "追加说明"]);
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.getByRole("button", { name: "继续", exact: true })).toBeVisible();
  await page
    .locator(".agent-compose")
    .screenshot({ path: test.info().outputPath("action-resume.png") });
  await page.getByRole("button", { name: "继续", exact: true }).click();
  expect(sent.at(-1)).toContain("继续之前");
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: "加载更早会话" }).click();
  await expect(card).toHaveCount(1);
  await expect(card.locator(":scope > details")).not.toHaveAttribute("open");
  await page.screenshot({ path: test.info().outputPath("agent-flow.png") });
  await page.getByRole("button", { name: "返回最新会话", exact: true }).click();
  const pathRequest = {
    ...access,
    id: "path-fixture",
    kind: "path",
    scope: "persistent",
    summary: { path: "/example/project" },
    status: "pending",
    decision: null,
    reason: "需要连续核查目录下的文档。连接后允许该路径范围内读写和执行命令。",
    action: { kind: "path", path: "/example/project", directory: true },
  };
  requests.push(pathRequest);
  running = false;
  rows.push(
    {
      seq: ++seq,
      agentId: agent.id,
      kind: "access",
      data: { requestId: pathRequest.id, nodeId: agent.id },
    },
    {
      seq: ++seq,
      agentId: agent.id,
      kind: "status",
      data: { reason: "access", text: "等待路径连接" },
    },
  );
  await page.route("**/api/v2/agent-access/path-fixture", (r) => {
    pathRequest.status = "approved";
    return r.fulfill({ json: pathRequest });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const pathCard = page.locator('[data-access-id="path-fixture"]');
  await expect(pathCard).toContainText("/example/project");
  await pathCard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("connect-path.png") });
  await pathCard.getByRole("button", { name: "批准授权", exact: true }).click();
  await expect(pathCard).toContainText("已批准");
  await expect(pathCard.locator(":scope > details")).not.toHaveAttribute("open");
  rows.push(
    {
      seq: ++seq,
      agentId: agent.id,
      kind: "tool",
      data: {
        id: "logical-report",
        callId: "delayed-report",
        name: "send_message",
        status: "error",
        approvalStatus: "expired",
        args: { kind: "result", target: { kind: "manager" }, message: "QA 已完成" },
        result: { content: [{ type: "text", text: '{"status":"expired","executed":false}' }] },
      },
    },
    { seq: ++seq, agentId: agent.id, kind: "user", data: { text: "检查进展" } },
    {
      seq: ++seq,
      agentId: agent.id,
      kind: "tool_update",
      data: {
        callId: "delayed-report",
        name: "report_result",
        status: "failed",
        approvalStatus: "expired",
        text: "后台工具 report_result internal-callback-prose",
        updatedAt: "2026-09-22T05:47:39Z",
        result: { content: [{ type: "text", text: '{"status":"expired","executed":false}' }] },
      },
    },
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const toolCard = page.locator(".tool-call-details").filter({ hasText: "提交报告" });
  await expect(toolCard).toHaveCount(1);
  await expect(toolCard).toContainText("审批已过期 · 未执行");
  await expect(page.getByText(/internal-callback-prose/)).toHaveCount(0);
  await toolCard.locator(":scope > summary").click();
  await toolCard.scrollIntoViewIfNeeded();
  await expect(toolCard).toContainText("此次操作未执行");
  await page.screenshot({ path: test.info().outputPath("tool-callback.png") });
  const axe = await new AxeBuilder({ page }).include(".workspace-panel").analyze();
  expect(axe.violations.filter((v) => ["critical", "serious"].includes(v.impact ?? ""))).toEqual(
    [],
  );
});
