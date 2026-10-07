import { randomUUID } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

const apiUrl = API_URL;
test("源码直接编辑、自动保存、Markdown 与 HTML 预览、复制图标和画布导航", async ({
  page,
  request,
}) => {
  const result = await request.post(`${apiUrl}/api/v2/nodes`, {
    data: {
      kind: "text",
      title: "直接编辑",
      text: "",
      parentId: "canvas-e2e",
      position: { x: 60, y: 130, width: 240, height: 160 },
      idempotencyKey: randomUUID(),
    },
  });
  const { node } = await result.json();
  await page.goto("/");
  await page.locator(`[data-node-id="${node.id}"]`).dblclick();
  const editor = page.getByLabel("编辑节点正文");
  await editor.fill("# 自动保存\n\n**重要证据**与[来源](https://example.com)。");
  await expect(async () => {
    const snapshot = await (
      await request.get(`${apiUrl}/api/v2/bootstrap?canvasId=canvas-e2e`)
    ).json();
    expect(snapshot.nodes.find((item: any) => item.id === node.id).text).toContain("自动保存");
  }).toPass();
  // CodeMirror owns line metrics and scrolls long source lines horizontally.
  await expect(async () => {
    const metrics = await page.locator(".source-editor").evaluate((host) => {
      const lines = Array.from(host.querySelectorAll(".cm-line"));
      const numbers = Array.from(host.querySelectorAll(".cm-lineNumbers .cm-gutterElement")).filter(
        (el) => (el as HTMLElement).style.visibility !== "hidden",
      );
      return lines.map((line, index) =>
        Math.abs(line.getBoundingClientRect().top - numbers[index]!.getBoundingClientRect().top),
      );
    });
    expect(metrics.length).toBe(3);
    for (const difference of metrics) expect(difference).toBeLessThan(1);
  }).toPass();
  const offset = () =>
    page.locator(".source-editor").evaluate((host) => {
      const line = host.querySelector(".cm-line")!;
      const number = Array.from(host.querySelectorAll(".cm-lineNumbers .cm-gutterElement")).find(
        (el) => (el as HTMLElement).style.visibility !== "hidden",
      )!;
      return Math.abs(line.getBoundingClientRect().top - number.getBoundingClientRect().top);
    });
  const fixedOffset = await offset();
  const shiftedGutterStyle = await page.addStyleTag({
    content: ".source-editor .cm-gutters { padding-top: 16px; }",
  });
  await expect.poll(offset).toBe(16);
  const shiftedOffset = await offset();
  await shiftedGutterStyle.evaluate((element) => (element as HTMLElement).remove());
  await expect.poll(offset).toBeLessThan(1);
  await test.info().attach("gutter-ablation.json", {
    body: JSON.stringify({ shiftedOffset, fixedOffset }),
    contentType: "application/json",
  });
  await page.getByRole("button", { name: "预览正文" }).click();
  await expect(page.getByRole("heading", { name: "自动保存" })).toBeVisible();
  await expect(page.locator(".document-preview strong")).toHaveText("重要证据");
  await page.getByRole("button", { name: "查看源码" }).click();
  await editor.press("ControlOrMeta+z");
  await expect(editor).not.toContainText("自动保存");
  await editor.press("ControlOrMeta+Shift+z");
  await expect(editor).toContainText("自动保存");
  await editor.fill(`${"long-source ".repeat(80)}\n第二行`);
  await expect(page.locator(".cm-line").first()).toHaveCSS("height", "19px");
  const scroller = page.locator(".cm-scroller");
  expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await scroller.evaluate((el) => {
    el.scrollLeft = 250;
  });
  await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await editor.fill('<h1>HTML 预览</h1><script>document.body.innerHTML="不应执行"</script>');
  await page.getByLabel("正文格式").selectOption("html");
  await page.getByRole("button", { name: "预览正文" }).click();
  const frame = page.frameLocator('iframe[title="HTML 预览"]');
  await expect(frame.getByRole("heading", { name: "HTML 预览" })).toBeVisible();
  await expect(frame.getByText("不应执行", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "画布路径" })).toContainText("我的画布");
  await expect(page.getByRole("navigation", { name: "画布路径" })).not.toContainText("根");
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "复制" }).locator("svg")).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath("editor-preview.png") });
});

test("保存失败保留草稿，重新选择后可重试", async ({ page, request }) => {
  const result = await request.post(`${apiUrl}/api/v2/nodes`, {
    data: {
      kind: "text",
      title: "草稿验证",
      text: "旧正文",
      parentId: "canvas-e2e",
      position: { x: 350, y: 150, width: 240, height: 160 },
      idempotencyKey: randomUUID(),
    },
  });
  const { node } = await result.json();
  await page.goto("/");
  await page.locator(`[data-node-id="${node.id}"]`).dblclick();
  await page.route(`**/api/v2/nodes/${node.id}`, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "INTERNAL", message: "保存暂不可用" } }),
    }),
  );
  await page.getByRole("button", { name: "查看源码" }).click();
  await page.getByLabel("编辑节点正文").fill("需要保留的草稿");
  await expect(page.locator(".save-error")).toContainText("草稿已保留");
  await page.reload();
  await page.locator(`[data-node-id="${node.id}"]`).dblclick();
  await expect(page.getByLabel("编辑节点正文")).toContainText("需要保留的草稿");
  await page.unroute(`**/api/v2/nodes/${node.id}`);
  await page.getByRole("button", { name: "保存正文" }).click();
  await expect(async () => {
    const snapshot = await (
      await request.get(`${apiUrl}/api/v2/bootstrap?canvasId=canvas-e2e`)
    ).json();
    expect(snapshot.nodes.find((item: any) => item.id === node.id).text).toBe("需要保留的草稿");
  }).toPass();
});

test("真实终端输入输出、切换工具后保留进程、调宽与关闭", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "打开侧栏" }).click();
  await page.getByRole("button", { name: "终端", exact: true }).click();
  const input = page.locator(".xterm-helper-textarea");
  await expect(input).toBeVisible();
  await expect(page.locator(".terminal-path")).not.toContainText("启动终端");
  await input.pressSequentially("printf 'UI_%s\\n' TERMINAL_OK", { delay: 10 });
  await input.press("Enter");
  await expect.poll(() => page.locator(".xterm-rows").innerText()).toContain("UI_TERMINAL_OK");
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("button", { name: "终端", exact: true }).click();
  await expect(page.locator(".xterm-rows")).toContainText("UI_TERMINAL_OK");
  await page.getByRole("button", { name: "展开阅读宽度" }).click();
  await page.screenshot({ path: test.info().outputPath("terminal.png") });
  await page.getByRole("button", { name: "结束终端进程" }).click();
  await expect(page.getByRole("button", { name: "结束终端进程" })).toBeDisabled();
});

test("流式会话先显示用户问题，输出期间可停止，真实工具事件可见", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "打开侧栏" }).click();
  await page.getByRole("button", { name: "模型会话", exact: true }).click();
  await page.getByLabel("模型问题").fill("概括当前证据");
  await page.getByLabel("模型问题").press("Enter");
  await expect(page.locator(".chat-user")).toContainText("概括当前证据");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.locator(".chat-assistant")).toContainText("已停止");
  await page.getByLabel("模型问题").fill("重新概括");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("button", { name: "运行", exact: true })).toBeVisible({
    timeout: 20000,
  });
  const summary = page.locator(".tool-call-details > summary").last();
  await expect(summary.locator(".tool-call-name")).toHaveText("读取画布");
  await expect(summary.locator(".tool-call-state")).toHaveText("完成");
  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations.filter((item) => item.impact === "critical" || item.impact === "serious"),
  ).toEqual([]);
});

test("收束容器摘要直接编辑，自动保存并在刷新后恢复", async ({ page, request }) => {
  const selection: string[] = [];
  for (let index = 0; index < 2; index++) {
    const result = await request.post(`${apiUrl}/api/v2/nodes`, {
      data: {
        kind: "text",
        title: `摘要来源 ${index}`,
        text: "来源内容",
        parentId: "canvas-e2e",
        position: { x: 3500 + index * 280, y: 500, width: 240, height: 160 },
        idempotencyKey: randomUUID(),
      },
    });
    selection.push((await result.json()).node.id);
  }
  const result = await request.post(`${apiUrl}/api/v2/operations`, {
    data: {
      type: "compress",
      scopeId: "canvas-e2e",
      selection,
      includeDescendants: [],
      includeConnected: false,
      instruction: "",
      idempotencyKey: randomUUID(),
    },
  });
  const { operation } = await result.json();
  await expect(async () => {
    const result = await request.get(`${apiUrl}/api/v2/operations/${operation.id}`);
    expect((await result.json()).operation.status).toBe("candidate");
  }).toPass();
  const accepted = await request.post(`${apiUrl}/api/v2/operations/${operation.id}/accept`, {
    data: { idempotencyKey: randomUUID() },
  });
  expect(accepted.ok()).toBe(true);
  const id = (await accepted.json()).operation.resultContainerId;
  await page.goto("/");
  await page.getByRole("button", { name: "适应画布", exact: true }).click();
  await page.locator(`[data-node-id="${id}"]`).dblclick();
  await page.getByRole("button", { name: "查看源码" }).click();
  await page.getByLabel("编辑节点正文").fill("# 修订摘要\n\n保留来源，更新结论。");
  await expect(async () => {
    const snapshot = await (
      await request.get(`${apiUrl}/api/v2/bootstrap?canvasId=canvas-e2e`)
    ).json();
    expect(snapshot.nodes.find((node: any) => node.id === id).summary).toContain("修订摘要");
  }).toPass();
  await page.reload();
  await page.getByRole("button", { name: "适应画布", exact: true }).click();
  await page.locator(`[data-node-id="${id}"]`).dblclick();
  await expect(page.getByRole("button", { name: "查看源码" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "修订摘要" })).toBeVisible();
});

test("工具与消息按执行顺序显示，展开输入输出，失败状态不会变成完成", async ({ page }) => {
  const stream = [
    { type: "start", mode: "mock", tools: ["read", "bash", "edit", "write", "read_canvas"] },
    { type: "message", id: 1, text: "先读取文件。", thinking: "检查选中的资料。" },
    { type: "tool", id: "read-1", name: "read", status: "pending", args: { path: "note.md" } },
    { type: "tool", id: "read-1", name: "read", status: "running" },
    {
      type: "tool",
      id: "read-1",
      name: "read",
      status: "complete",
      result: { content: [{ type: "text", text: "资料正文" }] },
    },
    { type: "message", id: 2, text: "再执行检查。", thinking: "" },
    {
      type: "tool",
      id: "bash-1",
      name: "bash",
      status: "running",
      args: { command: "example-check" },
    },
    {
      type: "tool",
      id: "bash-1",
      name: "bash",
      status: "error",
      result: { content: [{ type: "text", text: "命令退出码 1" }] },
    },
    {
      type: "tool",
      id: "bash-1",
      name: "bash",
      status: "pending",
      args: { command: "example-check" },
    },
    { type: "message", id: 3, text: "检查失败，文件读取成功。", thinking: "" },
    { type: "complete" },
  ];
  await page.route("**/api/v2/conversations/*", (route) => route.abort());
  await page.route("**/api/v2/agent/chat", (route) =>
    route.fulfill({
      contentType: "application/x-ndjson",
      body: `${stream.map((event) => JSON.stringify(event)).join("\n")}\n`,
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "打开侧栏" }).click();
  await page.getByRole("button", { name: "模型会话", exact: true }).click();
  await page.getByLabel("模型问题").fill("执行检查");
  await page.getByLabel("模型问题").press("Enter");
  const tools = page.locator(".tool-call-details");
  await expect(tools).toHaveCount(2);
  expect(await page.locator(".chat-assistant > *").allTextContents()).toEqual([
    expect.stringContaining("先读取文件。"),
    expect.stringContaining("读取完成"),
    expect.stringContaining("再执行检查。"),
    expect.stringContaining("运行命令失败"),
    expect.stringContaining("检查失败，文件读取成功。"),
  ]);
  await tools.first().locator(":scope > summary").click();
  await expect(tools.first().locator(".tool-target-path")).toContainText("note.md");
  await expect(tools.first().locator(".execution-target")).toHaveCount(0);
  await expect(tools.first().locator(".tool-call-body > pre")).toHaveText("资料正文");
  await tools.last().locator(":scope > summary").click();
  await expect(tools.last().locator(".tool-call-state")).toHaveText("失败");
  await expect(tools.last()).toContainText("命令退出码 1");
  await page.screenshot({ path: test.info().outputPath("tool-timeline.png") });
});
