import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

const api = API_URL;
test("两种输入区自动增长至三分之一高度，底部渐隐和上下文圆环可操作", async ({ page, request }) => {
  const board = (
    await (
      await request.post(`${api}/api/v2/canvases`, {
        data: { title: "输入区验收", idempotencyKey: randomUUID() },
      })
    ).json()
  ).node;
  const agent = (
    await (
      await request.post(`${api}/api/v2/nodes`, {
        data: {
          kind: "agent",
          parentId: board.id,
          title: "顾言",
          agent: { role: "read", persona: "核查资料", enabled: false },
          position: { x: 100, y: 100, width: 220, height: 300 },
          idempotencyKey: randomUUID(),
        },
      })
    ).json()
  ).node;
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: "输入区验收", exact: true }).click();
  await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
  const measurements: unknown[] = [];
  const checkInput = async (label: string) => {
    const field = page.getByLabel(label, { exact: true });
    await field.fill("一句任务");
    const small = (await field.boundingBox())!.height;
    await field.fill(
      Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 行：检查目录并核对资料。`).join("\n"),
    );
    const large = (await field.boundingBox())!.height;
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThanOrEqual(page.viewportSize()!.height / 3 + 1);
    await expect(field).toHaveCSS("resize", "none");
    await field.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect(field.locator("..")).toHaveClass(/has-more-below/);
    measurements.push({
      label,
      compactHeight: small,
      cappedHeight: large,
      naturalContentHeight: await field.evaluate((el) => el.scrollHeight),
      viewportHeight: page.viewportSize()!.height,
    });
    if (label === "Agent 任务")
      await page.screenshot({ path: test.info().outputPath("agent-input-capped.png") });

    await field.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect(field.locator("..")).not.toHaveClass(/has-more-below/);
    const ring = page.getByRole("button", { name: /上下文用量/ });
    await ring.hover();
    await expect(page.getByRole("tooltip")).toContainText("tokens");
    const picker = page.getByRole("button", {
      name: label === "Agent 任务" ? "Agent 模型" : "对话模型",
      exact: true,
    });
    const r = (await ring.boundingBox())!,
      m = (await picker.boundingBox())!;
    expect(Math.abs(r.y + r.height / 2 - m.y - m.height / 2)).toBeLessThan(5);
    await page.mouse.move(0, 0);
    await ring.focus();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await page.keyboard.press("Escape");
    await field.fill("");
    expect((await field.boundingBox())!.height).toBeLessThan(large);
  };
  await checkInput("Agent 任务");
  await page.getByRole("button", { name: "模型会话", exact: true }).click();
  await checkInput("模型问题");
  await page.getByLabel("模型问题").fill("简单说明当前画布");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("region", { name: "会话记录", exact: true })).toContainText(
    "模拟会话",
  );
  const violations = (
    await new AxeBuilder({ page }).include(".workspace-panel").analyze()
  ).violations.filter((v) => ["critical", "serious"].includes(v.impact ?? ""));
  expect(violations).toEqual([]);
  await page.getByRole("button", { name: /上下文用量/ }).hover();
  await expect(page.getByRole("tooltip")).toContainText("tokens");
  await page.screenshot({ path: test.info().outputPath("usage-ring.png") });
  writeFileSync(
    test.info().outputPath("composer-measurements.json"),
    JSON.stringify(measurements, null, 2),
  );
});
test("本机命令申请在会话中展示完整参数，由用户允许一次", async ({ page, request }) => {
  const board = (
    await (
      await request.post(`${api}/api/v2/canvases`, {
        data: { title: "本机工具验收", idempotencyKey: randomUUID() },
      })
    ).json()
  ).node;
  const agent = (
    await (
      await request.post(`${api}/api/v2/nodes`, {
        data: {
          kind: "agent",
          parentId: board.id,
          title: "工具测试",
          agent: { role: "read", persona: "读取资料", enabled: false },
          position: { x: 100, y: 100, width: 220, height: 300 },
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
    id: "host-access-fixture",
    agentId: agent.id,
    nodeId: agent.id,
    mode: "execute",
    reason: "安装需要的 CLI，仅执行本次命令",
    status: "pending",
    reviewerId: null,
    decision: null,
    action: {
      kind: "host",
      tool: "bash",
      args: { command: "npm install --prefix ./tools example-cli" },
    },
  };
  const events = [
    { seq: 1, agentId: agent.id, kind: "user", data: { text: "为这份文档安装所需工具" } },
    { seq: 2, agentId: agent.id, kind: "access", data: { requestId: access.id, nodeId: agent.id } },
  ];
  await page.route(`**/api/v2/canvas-agents/${agent.id}*`, (r) =>
    r.fulfill({ json: { events, requests: [access], running: false } }),
  );
  await page.route(`**/api/v2/agent-access/${access.id}`, async (r) => {
    access.status = "approved";
    return r.fulfill({ json: access });
  });
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: "本机工具验收", exact: true }).click();
  await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
  const card = page.locator(".agent-access-card");
  await expect(card).toContainText("服务器操作 · bash");
  await expect(card.locator(".access-card-summary")).not.toContainText("服务器：");
  await expect(card.getByText("所在服务器", { exact: true })).not.toBeVisible();
  await card.getByText("审批记录与技术详情", { exact: true }).click();
  await expect(card.getByText("所在服务器", { exact: true })).toBeVisible();
  await card.getByText("审批记录与技术详情", { exact: true }).click();
  await expect(card).toContainText(access.action.args.command);
  await page.screenshot({ path: test.info().outputPath("host-permission.png") });
  await card.getByRole("button", { name: "允许一次" }).click();
  await expect(card).toContainText("已批准");
  await page.getByRole("button", { name: "Agent 能力与设置" }).click();
  await page.getByText("可用工具", { exact: true }).click();
  await expect(page.getByText(/已发现 CLI/)).toBeVisible();
  await expect(page.getByText(/已安装.*技能/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("host-capabilities.png") });
});
