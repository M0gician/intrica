import { randomUUID } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import type { ApprovalDecision, ApprovalRecord } from "@intrica/contracts";
import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

const directoryRisk = "无命令执行权限";
const blockedRisk = "超出当前审查者的授权范围";
const longPath = `/home/reviewer/.local/share/intrica-server/state/data/workspaces/画布-${"审查資料é🙂".repeat(22)}/n-${"0123456789abcdef".repeat(10)}/交付物`;
const longCommand = `python review.py --artifact '${"pelican_scooter_质量检查🙂".repeat(30)}.gif'`;

function approval(
  agentId: string,
  id: string,
  patch: Partial<ApprovalRecord> = {},
): ApprovalRecord {
  return {
    id,
    agentId,
    toolCallId: null,
    status: "pending",
    version: 7,
    reviewerId: null,
    decidedBy: null,
    reason: "QA 申请审查交付物：核对 GIF 动画、逐帧统计及源文件。",
    decisionReason: null,
    routeReason: "user",
    kind: "path",
    scope: "persistent",
    summary: { path: longPath },
    names: { [agentId]: "视觉审查员" },
    action: { kind: "path", path: longPath, directory: true },
    expiresAt: "2099-09-22T05:38:00Z",
    reviewDueAt: null,
    allowedActions: ["approve", "deny", "escalate"],
    executionState: "waiting",
    createdAt: "2026-09-22T04:38:00Z",
    ...patch,
  };
}

async function fixture(page: Page, request: APIRequestContext, title: string) {
  const canvasResponse = await request.post(`${API_URL}/api/v2/canvases`, {
    data: { title, idempotencyKey: randomUUID() },
  });
  expect(canvasResponse.ok()).toBe(true);
  const board = (await canvasResponse.json()).node;
  const agentResponse = await request.post(`${API_URL}/api/v2/nodes`, {
    data: {
      kind: "agent",
      parentId: board.id,
      title: "审批复核员",
      agent: { role: "read", persona: "核对申请和授权范围。", enabled: false },
      position: { x: 120, y: 120, width: 220, height: 300 },
      idempotencyKey: randomUUID(),
    },
  });
  expect(agentResponse.ok()).toBe(true);
  const agent = (await agentResponse.json()).node;
  const suffix = randomUUID();
  const records = {
    path: approval(agent.id, `approval-layout-path-${suffix}`),
    host: approval(agent.id, `approval-layout-host-${suffix}`, {
      kind: "host",
      scope: "once",
      reason: "程序化检查动画质量，仅执行这一次命令。",
      summary: { tool: "bash" },
      action: { kind: "host", tool: "bash", args: { command: longCommand, fullHost: true } },
      allowedActions: ["approve", "deny"],
    }),
    blocked: approval(agent.id, `approval-layout-blocked-${suffix}`, {
      kind: "collaboration",
      scope: "once",
      reviewerId: agent.id,
      reason: "请将审查结果交给动画工程师。",
      summary: { recipients: ["fixture-recipient"] },
      names: { [agent.id]: "视觉审查员", "fixture-recipient": "动画工程师" },
      blockedReason: "outside_authority",
      allowedActions: ["deny", "escalate"],
      reviewDueAt: "2099-09-22T05:08:00Z",
    }),
    resolved: approval(agent.id, `approval-layout-resolved-${suffix}`, {
      status: "approved",
      decidedBy: "owner",
      decisionReason: "用户批准：允许 QA 访问这份交付目录。",
      decidedAt: "2026-09-22T04:39:00Z",
      // A stale historical payload must never restore decision buttons.
      allowedActions: ["approve", "deny", "escalate"],
    }),
    message: approval(agent.id, `approval-layout-message-${suffix}`, {
      kind: "collaboration",
      scope: "once",
      reason: "向交付负责人发送核验结论。",
      summary: { recipients: ["fixture-recipient"] },
      names: { [agent.id]: "视觉审查员", "fixture-recipient": "动画工程师" },
      action: {
        kind: "collaboration",
        recipients: ["fixture-recipient"],
        message: "核验记录：GIF 已逐帧检查。\n申请说明：此行是待发送的原文内容。",
        messageKind: "message",
      },
    }),
  };
  delete records.blocked.action;
  const requests = Object.values(records);
  const events = requests.map((record, index) => ({
    seq: index + 1,
    agentId: agent.id,
    kind: "permission_notice",
    data: { requestId: record.id, text: '{"event":"permission_review"}' },
    createdAt: "2026-09-22T04:38:00Z",
  }));
  await page.route(
    (url) => url.pathname === `/api/v2/canvas-agents/${agent.id}`,
    (route) => route.fulfill({ json: { events, requests, running: false } }),
  );
  const decisions: Array<{
    id: string;
    method: string;
    body: { decision: ApprovalDecision; version: number; reason: string; idempotencyKey: string };
  }> = [];
  const byPath = new Map(requests.map((record) => [`/api/v2/agent-access/${record.id}`, record]));
  await page.route(
    (url) => byPath.has(url.pathname),
    async (route) => {
      const record = byPath.get(new URL(route.request().url()).pathname)!;
      const body = route.request().postDataJSON();
      decisions.push({ id: record.id, method: route.request().method(), body });
      if (body.decision === "escalate") {
        record.reviewerId = null;
        record.allowedActions = ["approve", "deny"];
        record.reviewDueAt = null;
      } else {
        record.status = body.decision === "approve" ? "approved" : "denied";
        record.allowedActions = [];
        record.decidedBy = "owner";
        record.decidedAt = "2026-09-22T04:39:00Z";
        record.decisionReason = body.reason;
      }
      record.version += 1;
      await route.fulfill({ json: record });
    },
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: title, exact: true }).click();
  await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
  await expect(page.locator(".agent-access-card")).toHaveCount(requests.length);
  return {
    records,
    decisions,
    card: (record: ApprovalRecord) => page.locator(`[data-access-id="${record.id}"]`),
  };
}

async function resizeSidebar(page: Page, width: number) {
  const separator = page.getByRole("separator", { name: "调整侧栏宽度", exact: true });
  let current = Number(await separator.getAttribute("aria-valuenow"));
  while (current !== width) {
    await separator.press(current > width ? "ArrowRight" : "ArrowLeft");
    const next = Number(await separator.getAttribute("aria-valuenow"));
    expect(next).not.toBe(current);
    current = next;
  }
  expect((await page.locator(".workspace-panel").boundingBox())!.width).toBeCloseTo(width, 0);
}

async function expectNoOverflow(card: Locator) {
  const overflows = await card.evaluate((element) =>
    [
      element,
      ...Array.from(
        element.querySelectorAll(
          ".access-card-summary, .access-card-body, .access-request, .access-target, .access-impact, .access-resolution, .access-path, .access-command, .access-record-details, pre, button",
        ),
      ),
    ]
      .filter((node) => node.clientWidth > 0)
      .map((node) => ({
        selector: node.className,
        overflow: node.scrollWidth - node.clientWidth,
      })),
  );
  expect(overflows.filter(({ overflow }) => overflow > 2)).toEqual([]);
}

test("审批通知分清申请、对象、授权影响和结果，窄栏长内容可读且展开不提交决定", async ({
  page,
  request,
}) => {
  const { records, decisions, card } = await fixture(page, request, "审批可读性回归");
  const path = card(records.path);
  const host = card(records.host);
  const blocked = card(records.blocked);
  const resolved = card(records.resolved);
  const message = card(records.message);

  await expect(path.locator(":scope > details")).toHaveAttribute("open");
  await expect(
    path.locator(".access-request").getByRole("heading", { name: "申请说明" }),
  ).toBeVisible();
  await expect(path.locator(".access-request")).toContainText(records.path.reason);
  await expect(path.locator(".access-request")).toContainText("视觉审查员");
  await expect(path.locator(".access-request")).not.toContainText(directoryRisk);
  await expect(
    path.locator(".access-target").getByRole("heading", { name: "操作对象" }),
  ).toBeVisible();
  await expect(path.locator("code.access-path")).toHaveText(longPath);
  await expect(
    path.locator(".access-impact").getByRole("heading", { name: "授权影响" }),
  ).toBeVisible();
  await expect(path.locator(".access-impact")).toContainText(directoryRisk);
  await expect(path.locator(".access-impact")).toContainText("持续授权");
  await expect(host.locator("pre.access-command")).toHaveText(longCommand);
  const command = host.locator("pre.access-command");
  await command.focus();
  await command.press("PageDown");
  await expect.poll(() => command.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(host.locator(".access-impact")).toContainText("完整宿主执行权限");
  await expect(host.locator(".access-impact")).toContainText("仅限本次操作");
  await expect(blocked.locator(".access-impact")).toContainText(blockedRisk);
  await expect(blocked).toContainText("动画工程师");
  await expect(blocked.getByRole("button", { name: /允许一次|批准授权/ })).toHaveCount(0);
  await expect(message.getByRole("heading", { name: "待发送内容", exact: true })).toBeVisible();
  await expect(message.locator(".access-message")).toContainText("此行是待发送的原文内容");
  await expect(message.locator(".access-request")).not.toContainText("此行是待发送的原文内容");
  await expect(page.locator(".agent-activity")).not.toContainText('"permission_review"');

  await expect(resolved.locator(":scope > details")).not.toHaveAttribute("open");
  await resolved.locator(":scope > details > summary").press("Enter");
  await expect(
    resolved.locator(".access-resolution").getByRole("heading", { name: "处理结果" }),
  ).toBeVisible();
  await expect(resolved.locator(".access-resolution")).toContainText(
    records.resolved.decisionReason!,
  );
  await expect(
    resolved.getByRole("button", { name: /批准授权|允许一次|拒绝|由用户接管/ }),
  ).toHaveCount(0);

  for (const width of [320, 480]) {
    await resizeSidebar(page, width);
    for (const [name, approvalCard] of [
      ["path", path],
      ["host", host],
      ["blocked", blocked],
      ["resolved", resolved],
      ["message", message],
    ] as const) {
      await expectNoOverflow(approvalCard);
      const technical = approvalCard.locator(".access-record-details");
      const toggle = technical.locator(":scope > summary");
      await expect(toggle).toHaveText("审批记录与技术详情");
      await expect(technical).not.toHaveAttribute("open");
      await toggle.press("Enter");
      await expect(technical).toHaveAttribute("open");
      if (name !== "blocked") {
        await expect(technical).toContainText("操作参数与内部标识");
        await expect(technical.locator("pre")).toBeVisible();
      }
      await expectNoOverflow(approvalCard);
      await toggle.press("Space");
      await expect(technical).not.toHaveAttribute("open");
      if (name === "path" || name === "resolved" || name === "blocked") {
        await approvalCard.screenshot({
          path: test.info().outputPath(`approval-${name}-${width}.png`),
        });
      }
    }
    expect(
      await page
        .locator(".agent-timeline-scroll")
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(2);
  }

  await resolved.getByRole("button", { name: "查看当前有效权限", exact: true }).click();
  const permissions = page.getByRole("dialog", { name: "Agent 访问权限", exact: true });
  await expect(permissions).toBeVisible();
  await expect(
    permissions.getByRole("heading", { name: "当前有效权限", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(permissions).toHaveCount(0);
  await expect(resolved.locator(".access-summary-state")).toHaveText("已批准");
  expect(decisions).toEqual([]);
  // Keep the stress checks above, then capture an ordinary-length request for visual review.
  const samplePath =
    "/home/reviewer/.local/share/intrica-server/state/data/workspaces/canvas-4/qa-review";
  for (const record of [records.path, records.resolved]) {
    record.summary.path = samplePath;
    record.action = { kind: "path", path: samplePath, directory: true };
    record.reason =
      "QA 审查交付物：需要对 pelican_scooter.gif、contact_sheet.png 和 pelican_gif.py 进行程序化质量检查（PIL 校验、逐帧统计、源码检查）。";
    record.expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  }
  await page.setViewportSize({ width: 1280, height: 1200 });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(resolved.locator("code.access-path")).toHaveText(samplePath);
  for (const [name, approvalCard] of [
    ["pending", path],
    ["resolved", resolved],
  ] as const) {
    await approvalCard.scrollIntoViewIfNeeded();
    await page.mouse.move(20, 20);
    await approvalCard.screenshot({
      path: test.info().outputPath(`approval-overview-${name}.png`),
    });
  }
  const violations = (await new AxeBuilder({ page }).include(".agent-access-card").analyze())
    .violations;
  expect(
    violations.filter((violation) => ["critical", "serious"].includes(violation.impact ?? "")),
  ).toEqual([]);
});

test("审批主次按钮仅向对应申请提交允许、拒绝或转交，已处理卡保持历史结果", async ({
  page,
  request,
}) => {
  const { records, decisions, card } = await fixture(page, request, "审批按钮回归");
  await resizeSidebar(page, 320);
  const path = card(records.path);
  const approve = path.getByRole("button", { name: "批准授权", exact: true });
  const deny = path.getByRole("button", { name: "拒绝", exact: true });
  const escalate = path.getByRole("button", { name: "由用户接管", exact: true });
  const colors = await Promise.all(
    [approve, deny, escalate].map((button) =>
      button.evaluate((element) => getComputedStyle(element).backgroundColor),
    ),
  );
  expect(new Set(colors).size).toBe(3);
  for (const button of [approve, deny, escalate]) {
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(32);
  }
  await approve.press("Enter");
  await expect(path.locator(".access-summary-state")).toHaveText("已批准");
  await expect(path.locator(":scope > details")).not.toHaveAttribute("open");
  await path.locator(":scope > details > summary").press("Space");
  await expect(path.getByRole("button", { name: /批准授权|拒绝|由用户接管/ })).toHaveCount(0);

  const host = card(records.host);
  await host.getByRole("button", { name: "拒绝", exact: true }).click();
  await expect(host.locator(".access-summary-state")).toHaveText("已拒绝");
  await expect(host.locator(":scope > details")).not.toHaveAttribute("open");
  const blocked = card(records.blocked);
  await blocked.getByRole("button", { name: "由用户接管", exact: true }).click();
  await expect(blocked.locator(".access-summary-state")).toHaveText("等待审批");
  await expect(blocked.locator(".access-reviewer")).toHaveText("等待你的决定");
  await expect(blocked.getByRole("button", { name: "由用户接管", exact: true })).toHaveCount(0);

  expect(decisions).toEqual([
    {
      id: records.path.id,
      method: "POST",
      body: {
        decision: "approve",
        version: 7,
        reason: "用户批准",
        idempotencyKey: expect.any(String),
      },
    },
    {
      id: records.host.id,
      method: "POST",
      body: {
        decision: "deny",
        version: 7,
        reason: "用户拒绝",
        idempotencyKey: expect.any(String),
      },
    },
    {
      id: records.blocked.id,
      method: "POST",
      body: {
        decision: "escalate",
        version: 7,
        reason: "由用户接管",
        idempotencyKey: expect.any(String),
      },
    },
  ]);
  const keys = decisions.map(({ body }) => body.idempotencyKey);
  expect(keys.every((key) => key.length > 0)).toBe(true);
  expect(new Set(keys).size).toBe(3);
  await expect(card(records.resolved).locator(".access-summary-state")).toHaveText("已批准");
  await expectNoOverflow(path);
  await expectNoOverflow(blocked);
});
