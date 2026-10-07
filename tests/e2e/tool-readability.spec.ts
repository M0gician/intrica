import { randomUUID } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

const result = (value: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

async function fixture(
  page: Page,
  request: APIRequestContext,
  title: string,
  tools: (ids: { agentId: string; resourceId: string }) => Record<string, unknown>[],
) {
  const boardResponse = await request.post(`${API_URL}/api/v2/canvases`, {
    data: { title, idempotencyKey: randomUUID() },
  });
  expect(boardResponse.ok()).toBe(true);
  const board = (await boardResponse.json()).node;
  const createNode = async (data: Record<string, unknown>) => {
    const response = await request.post(`${API_URL}/api/v2/nodes`, {
      data: {
        parentId: board.id,
        position: { x: 120, y: 120, width: 220, height: 300 },
        idempotencyKey: randomUUID(),
        ...data,
      },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()).node;
  };
  const agent = await createNode({
    kind: "agent",
    title: "工具记录复核员",
    agent: { role: "read", persona: "核对工具调用记录。", enabled: false },
  });
  const resource = await createNode({
    kind: "text",
    title: "动画交付验收记录",
    text: "已核对 GIF、逐帧统计和源文件。",
    position: { x: 420, y: 120, width: 220, height: 300 },
  });
  const calls = tools({ agentId: agent.id, resourceId: resource.id });
  const events = calls.map((data, index) => ({
    seq: index + 1,
    agentId: agent.id,
    kind: "tool",
    createdAt: "2026-09-22T04:38:00Z",
    data: {
      id: `fixture-tool-${index}`,
      callId: `fixture-call-${index}`,
      status: "complete",
      updatedAt: "2026-09-22T04:38:58Z",
      ...data,
    },
  }));
  await page.route(
    (url) => url.pathname === `/api/v2/canvas-agents/${agent.id}`,
    (route) => route.fulfill({ json: { events, requests: [], running: false } }),
  );
  const decisions: string[] = [];
  page.on("request", (sent) => {
    if (sent.method() !== "GET" && new URL(sent.url()).pathname.startsWith("/api/v2/agent-access/"))
      decisions.push(sent.url());
  });
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: title, exact: true }).click();
  await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
  await expect(page.locator(".tool-call-details")).toHaveCount(calls.length);
  return {
    agent,
    resource,
    decisions,
    card: (index: number) => page.locator(".tool-call-details").nth(index),
  };
}

async function expand(card: Locator) {
  await card.locator(":scope > summary").press("Enter");
  await expect(card).toHaveAttribute("open");
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
      ...Array.from(element.querySelectorAll("summary, div, dl, dd, ul, li, p, pre, code, button")),
    ]
      .filter((node) => node.clientWidth > 0)
      .map((node) => ({
        selector: node.className || node.tagName,
        overflow: node.scrollWidth - node.clientWidth,
      }))
      .filter(({ overflow }) => overflow > 2),
  );
  expect(overflows).toEqual([]);
}

test("权限审查、申请列表和画布读取展示可读结果，技术信息按需展开且导航不审批", async ({
  page,
  request,
}) => {
  const { resource, card, decisions } = await fixture(
    page,
    request,
    "工具可读性回归",
    ({ agentId, resourceId }) => [
      {
        name: "review_access_request",
        args: {
          requestId: "approval-review-readable",
          version: 1,
          decision: "escalate",
          reason: "QA 需要访问交付目录，超出当前审查者的授权范围，转交上级审查。",
        },
        result: result({ status: "pending" }),
      },
      {
        name: "list_access_requests",
        args: { limit: 2 },
        result: result({
          requests: [
            {
              id: "approval-review-readable",
              agentId,
              reviewerId: null,
              status: "pending",
              kind: "path",
              scope: "persistent",
              summary: { path: "/home/reviewer/animation-delivery" },
              names: { [agentId]: "视觉审查员" },
              reason: "",
              allowedActions: [],
            },
            {
              id: "approval-read-readable",
              agentId,
              reviewerId: null,
              status: "pending",
              kind: "resource",
              scope: "persistent",
              summary: { resourceIds: [resourceId], mode: "read" },
              names: { [agentId]: "视觉审查员", [resourceId]: "动画交付验收记录" },
              reason: "",
              allowedActions: ["approve", "deny"],
            },
          ],
          total: 3,
          nextCursor: "approval-read-readable",
        }),
      },
      {
        name: "read_canvas",
        args: { query: "动画", limit: 1, offset: 0 },
        result: result({
          nodes: [
            {
              id: resourceId,
              kind: "text",
              parent_id: null,
              title: "动画交付验收记录",
              excerpt: "已核对 GIF、逐帧统计和源文件。",
            },
          ],
          nextOffset: 1,
        }),
      },
      {
        name: "wait_for_message",
        args: {},
        result: result({ waiting: true }),
      },
    ],
  );
  const review = card(0),
    requests = card(1),
    canvas = card(2),
    waiting = card(3);
  await expect(review.locator(":scope > summary")).toContainText("审查权限申请");
  await expect(review.locator(":scope > summary")).toContainText("已转交 · 仍待审批");
  await expect(requests.locator(":scope > summary")).toContainText("查看权限申请");
  for (const entry of [review, requests, canvas, waiting]) {
    await expand(entry);
    await expect(entry).not.toContainText("执行服务器");
    await expect(entry).not.toContainText("状态更新");
    await expect(entry.locator("pre")).toHaveCount(0);
  }
  await expect(review.locator(".tool-result-summary")).toContainText("转交上级");
  await expect(review.locator(".tool-result-summary")).toContainText("审查备注");
  await expect(review.locator(".tool-result-summary")).toContainText("超出当前审查者的授权范围");
  await expect(review.locator(".tool-result-summary")).toContainText("仍待审批");
  await expect(review.locator(".tool-result-summary")).not.toContainText("已批准");
  await expect(requests.locator(".tool-result-summary")).toContainText("本页 2 项申请");
  await expect(requests.locator(".tool-result-summary")).toContainText("视觉审查员");
  await expect(requests.locator(".tool-result-summary")).toContainText(
    "/home/reviewer/animation-delivery",
  );
  await expect(requests.locator(".tool-result-summary")).toContainText("还有后续结果");
  await expect(
    requests.getByRole("button", { name: /允许一次|批准授权|拒绝|由用户接管/ }),
  ).toHaveCount(0);
  await expect(canvas.locator(".tool-result-summary")).toContainText("本页 1 个节点");
  await expect(canvas.locator(".tool-result-summary")).toContainText(
    "已核对 GIF、逐帧统计和源文件。",
  );
  await expect(canvas.locator(".tool-result-summary")).toContainText("还有后续结果");
  await expect(waiting.locator(":scope > summary")).toContainText("已让出执行，等待新消息");

  for (const width of [320, 480]) {
    await resizeSidebar(page, width);
    for (const entry of [review, requests, canvas, waiting]) await expectNoOverflow(entry);
  }
  const diagnostics = review.getByText("原始参数、结果与内部标识", { exact: true });
  await diagnostics.press("Enter");
  await expect(review.locator("pre")).toContainText("approval-review-readable");
  await expect(review).toContainText("执行服务器");
  await expect(review).toContainText("状态更新");
  await diagnostics.press("Space");
  await expect(review.locator("pre")).toHaveCount(0);
  await expect(review).not.toContainText("执行服务器");
  await review.screenshot({ path: test.info().outputPath("tool-review-readable.png") });
  await requests.screenshot({ path: test.info().outputPath("tool-requests-readable.png") });

  await requests.locator(":scope > summary").press("Enter");
  await waiting.locator(":scope > summary").press("Enter");
  await review.scrollIntoViewIfNeeded();
  await page
    .locator(".workspace-panel")
    .screenshot({ path: test.info().outputPath("tool-overview-readable.png") });
  const violations = await new AxeBuilder({ page }).include(".workspace-panel").analyze();
  expect(
    violations.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
  await canvas.getByRole("button", { name: /动画交付验收记录/ }).click();
  await expect(page.getByRole("textbox", { name: "节点标题", exact: true })).toHaveValue(
    resource.title,
  );
  await expect(page.getByRole("region", { name: "完整内容", exact: true })).toContainText(
    "已核对 GIF",
  );
  expect(decisions).toEqual([]);
});

test("工具失败、未知结构和转义内容不伪造成功，窄栏长结果仍可读", async ({ page, request }) => {
  const untrusted = '<img src=x onerror="window.__toolInjected = true"> & "申请原文"';
  const longPath = `/home/reviewer/${"动画交付é🙂".repeat(40)}/result.gif`;
  const { card, decisions } = await fixture(page, request, "工具边界可读性回归", ({ agentId }) => [
    {
      name: "review_access_request",
      status: "error",
      args: {
        requestId: "changed-approval",
        version: 1,
        decision: "approve",
        reason: "申请已变化前的审查备注。",
      },
      result: {
        content: [{ type: "text", text: "VERSION_CONFLICT: 申请已变化（pending），请重新载入" }],
        isError: true,
      },
    },
    {
      name: "list_access_requests",
      args: {},
      result: { content: [{ type: "text", text: `{ malformed result: ${untrusted}` }] },
    },
    {
      name: "read_canvas",
      args: {},
      result: result({ unexpected: "legacy-output" }),
    },
    {
      name: "list_access_requests",
      args: { requestId: "approval-long-path" },
      result: result({
        requests: [
          {
            id: "approval-long-path",
            agentId,
            reviewerId: null,
            status: "approved",
            kind: "path",
            scope: "persistent",
            names: { [agentId]: untrusted },
            summary: { path: longPath },
            reason: "",
            allowedActions: [],
          },
        ],
        total: 1,
        nextCursor: null,
      }),
    },
  ]);
  const failure = card(0),
    malformed = card(1),
    unknown = card(2),
    long = card(3);
  for (const entry of [failure, malformed, unknown, long]) await expand(entry);
  await expect(failure.locator(":scope > summary")).toContainText("失败");
  await expect(failure.locator(":scope > summary")).not.toContainText("已批准");
  await expect(failure).toContainText("VERSION_CONFLICT");
  await expect(failure).toContainText("请重新载入");
  await expect(malformed).toContainText(untrusted);
  await expect(malformed.locator("img")).toHaveCount(0);
  await expect(long).toContainText(untrusted);
  await expect(long.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => "__toolInjected" in window)).toBe(false);
  await expect(long).toContainText(longPath);
  await expect(unknown).not.toContainText("0 个节点");
  await expect(unknown).not.toContainText("legacy-output");
  await unknown.getByText("原始参数、结果与内部标识", { exact: true }).press("Enter");
  await expect(unknown.locator("pre")).toContainText("legacy-output");
  await unknown.getByText("原始参数、结果与内部标识", { exact: true }).press("Space");
  await resizeSidebar(page, 320);
  for (const entry of [failure, malformed, unknown, long]) await expectNoOverflow(entry);
  await long.scrollIntoViewIfNeeded();
  await page
    .locator(".workspace-panel")
    .screenshot({ path: test.info().outputPath("tool-edge-cases-320.png") });
  expect(decisions).toEqual([]);
});
