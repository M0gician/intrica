import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Node } from "@intrica/contracts";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

const apiUrl = API_URL;
test("容器布局、内部框选、拖动保存和侧栏独立滚动", async ({ page, request }) => {
  const slots = new Map<string, number>();
  const create = async (title: string, parentId: string, text = "") => {
    const slot = slots.get(parentId) ?? 0;
    slots.set(parentId, slot + 1);
    const result = await request.post(`${apiUrl}/api/v2/nodes`, {
      data: {
        kind: "text",
        title,
        text,
        parentId,
        position: { x: 16 + slot * 260, y: 80, width: 240, height: 160 },
        idempotencyKey: randomUUID(),
      },
    });
    expect(result.ok()).toBe(true);
    return (await result.json()).node as Node;
  };
  const container = await create("验收资料", "canvas-e2e");
  const first = await create(
    "线索甲",
    container.id,
    `## 调查笔记\n${"长段落用于验证正文独立滚动。\n\n".repeat(120)}`,
  );
  const second = await create("线索乙", container.id);
  await create("线索丙", container.id);
  await page.goto("/");
  const card = page.locator(`[data-node-id="${container.id}"]`);
  await expect(card.getByLabel("子项预览")).toContainText("线索甲");
  await card.dblclick();
  await page.getByRole("button", { name: "进入内部", exact: true }).first().click();
  const overlay = page.getByRole("region", { name: /临时内部空间.*验收资料/ });
  await expect(overlay).toBeVisible();
  const a = overlay.locator(`[data-node-id="${first.id}"]`);
  const b = overlay.locator(`[data-node-id="${second.id}"]`);
  await expect(async () => {
    const aa = await a.boundingBox();
    const bb = await b.boundingBox();
    expect(aa!.x + aa!.width).toBeLessThan(bb!.x);
  }).toPass();
  // Opened overlay has fitted its bounds to the canvas; close detail to free pointer paths.
  await page.getByRole("button", { name: "关闭详情侧栏" }).click();
  const aa = (await a.boundingBox())!;
  const bb = (await b.boundingBox())!;
  await page.mouse.move(aa.x - 7, aa.y - 7);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width + 4, bb.y + bb.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByRole("toolbar", { name: "选中操作栏" })).toContainText("已选择 2 项");
  await page.mouse.move(aa.x - 7, aa.y - 7);
  await page.mouse.down();
  await page.mouse.move(aa.x + 20, aa.y + 20);
  await expect(page.locator(".overlay-marquee")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".overlay-marquee")).toHaveCount(0);
  await expect(overlay).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "选中操作栏" })).toContainText("已选择 2 项");
  // Space-drag works over the inner canvas as well as over empty root canvas.
  const transformBeforePan = await page.locator(".canvas-world").getAttribute("style");
  await page.keyboard.down("Space");
  await page.mouse.move(aa.x - 7, aa.y - 7);
  await page.mouse.down();
  await page.mouse.move(aa.x + 33, aa.y + 13, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  expect(await page.locator(".canvas-world").getAttribute("style")).not.toBe(transformBeforePan);
  await expect(page.getByRole("toolbar", { name: "选中操作栏" })).toContainText("已选择 2 项");
  await a.dblclick();
  const before = await a.evaluate((element) => ({
    x: (element as HTMLElement).style.left,
    y: (element as HTMLElement).style.top,
  }));
  const head = (await a.locator("header").boundingBox())!;
  await page.mouse.move(head.x + 50, head.y + 14);
  await page.mouse.down();
  await page.mouse.move(head.x + 50, head.y + 30, { steps: 5 });
  const dragging = page.locator(`[data-node-id="${first.id}"].node-dragging`);
  await expect(dragging).toBeVisible();
  expect((await dragging.boundingBox())!.y).toBeGreaterThan(head.y);
  expect(
    await dragging.evaluate((element) => getComputedStyle(element).transitionProperty),
  ).not.toMatch(/\b(left|top|transform)\b/);
  await page.mouse.up();
  await expect(async () => {
    const snapshot = await (
      await request.get(`${apiUrl}/api/v2/bootstrap?canvasId=canvas-e2e`)
    ).json();
    expect(snapshot.nodes.find((node: Node) => node.id === first.id).position.y).toBeGreaterThan(
      parseFloat(before.y),
    );
  }).toPass();
  const transform = await page.locator(".canvas-world").getAttribute("style");
  await page.getByRole("button", { name: "查看源码" }).click();
  const editorScroll = page.locator(".cm-scroller");
  await editorScroll.hover();
  await page.mouse.wheel(0, 300);
  await expect.poll(() => editorScroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.locator(".canvas-world").getAttribute("style")).toBe(transform);
  await page.getByRole("button", { name: "预览正文" }).click();
  const body = page.locator(".document-preview");
  await body.hover();
  await page.mouse.wheel(0, 400);
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.locator(".canvas-world").getAttribute("style")).toBe(transform);
  const separator = page.getByRole("separator", { name: "调整侧栏宽度" });
  const box = (await separator.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x - 180, box.y + 100);
  await page.mouse.up();
  expect((await page.locator(".workspace-panel").boundingBox())!.width).toBeGreaterThan(600);
  await page.screenshot({ path: test.info().outputPath("container-and-details.png") });
  // Reload and reopen: the user-arranged position survives, with no render-time reflow.
  const movedTop = await a.evaluate((element) => (element as HTMLElement).style.top);
  await page.reload();
  await card.dblclick();
  await page.getByRole("button", { name: "进入内部", exact: true }).first().click();
  await expect(a).toHaveCSS("top", movedTop);
});

test("文件目录保留层级，网页摘录落到画布，侧栏无需选区即可打开", async ({ page, request }) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "intrica-import-")));
  mkdirSync(join(directory, "资料"));
  writeFileSync(join(directory, "资料", "证据.md"), "# 导入证据\n真实文件内容");
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "打开侧栏" }).click();
    await page.getByRole("button", { name: "文件", exact: true }).click();
    await page.locator("button.file-location").click();
    await page.getByLabel("服务器目录路径").fill(directory);
    await page.getByRole("button", { name: "打开目录", exact: true }).click();
    await page.getByRole("button", { name: "资料", exact: true }).click();
    await expect(page.getByRole("button", { name: "证据.md", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "添加当前目录到画布" }).click();
    const rootName = directory.split("/").at(-1)!;
    await expect(async () => {
      const snapshot = await (
        await request.get(`${apiUrl}/api/v2/bootstrap?canvasId=canvas-e2e`)
      ).json();
      const folder = snapshot.nodes.find((node: Node) => node.title === rootName);
      expect(folder?.resource).toEqual({ type: "directory", path: directory });
      expect(folder?.childOrder).toEqual([]);
      expect(snapshot.nodes.some((node: Node) => node.title === "证据.md")).toBe(false);
    }).toPass();
    await page.getByLabel("搜索目录树").fill("证据");
    await expect(page.getByRole("button", { name: "资料/证据.md", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "资料/证据.md", exact: true }).click();
    await expect(page.locator(".file-preview")).toContainText("真实文件内容");
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载到此设备", exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe("证据.md");
    expect(readFileSync((await download.path())!, "utf8")).toBe("# 导入证据\n真实文件内容");
    await page.getByRole("button", { name: "添加文件到画布", exact: true }).click();
    await expect(async () => {
      const snapshot = await (
        await request.get(`${apiUrl}/api/v2/bootstrap?canvasId=canvas-e2e`)
      ).json();
      expect(snapshot.nodes.find((node: Node) => node.title === "证据.md")?.text).toContain(
        "真实文件内容",
      );
    }).toPass();
    const data = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", "这是一段网页摘录");
      transfer.setData("text/uri-list", "https://example.com/source");
      return transfer;
    });
    await page
      .locator(".canvas-viewport")
      .dispatchEvent("drop", { dataTransfer: data, clientX: 100, clientY: 250 });
    await expect(async () => {
      const snapshot = await (
        await request.get(`${apiUrl}/api/v2/bootstrap?canvasId=canvas-e2e`)
      ).json();
      expect(
        snapshot.nodes.some((node: Node) =>
          node.text?.includes("这是一段网页摘录\n\n来源：https://example.com/source"),
        ),
      ).toBe(true);
    }).toPass();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("PI 会话连续两轮、切换模式保留记录，缩放幅度足够且平移不改比例", async ({ page }) => {
  await page.goto("/");
  const world = page.locator(".canvas-world");
  const initial = await world.getAttribute("style");
  await page
    .locator(".canvas-viewport")
    .dispatchEvent("wheel", { ctrlKey: true, deltaY: -80, clientX: 200, clientY: 250 });
  await expect(page.locator(".zoom-value")).toHaveText("190%");
  const zoom = await page.locator(".zoom-value").textContent();
  await page
    .locator(".canvas-viewport")
    .dispatchEvent("wheel", { deltaY: 120, deltaX: 80, clientX: 200, clientY: 250 });
  expect(await world.getAttribute("style")).not.toBe(initial);
  expect(await page.locator(".zoom-value").textContent()).toBe(zoom);
  await page.getByRole("button", { name: "打开侧栏" }).click();
  await page.getByRole("button", { name: "模型会话", exact: true }).click();
  await page.getByLabel("模型问题").fill("概括画布证据");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("region", { name: "会话记录", exact: true })).toContainText(
    "模拟会话第 1 轮",
  );
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("button", { name: "模型会话", exact: true }).click();
  await page.getByLabel("模型问题").fill("继续比较它们");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("region", { name: "会话记录", exact: true })).toContainText(
    "模拟会话第 2 轮",
  );
  await page.getByRole("button", { name: "关闭详情侧栏" }).click();
  await page.getByRole("button", { name: "打开侧栏" }).click();
  await expect(page.getByRole("region", { name: "会话记录", exact: true })).toContainText(
    "继续比较它们",
  );
  await page
    .locator(".canvas-viewport")
    .dispatchEvent("pointerdown", { button: 0, clientX: 60, clientY: 500 });
  await page
    .locator(".canvas-viewport")
    .dispatchEvent("pointerup", { button: 0, clientX: 60, clientY: 500 });
  await expect(page.getByRole("region", { name: "会话记录", exact: true })).toBeVisible();
});

test("触屏在节点上捏合，抬起一指后继续平移；工具栏可达且详情切换明确", async ({
  page,
  context,
  request,
}) => {
  const result = await request.post(`${apiUrl}/api/v2/nodes`, {
    data: {
      kind: "text",
      title: "触控验证",
      text: "内容",
      parentId: "canvas-e2e",
      position: { x: 150, y: 350, width: 240, height: 160 },
      idempotencyKey: randomUUID(),
    },
  });
  expect(result.ok()).toBe(true);
  const { node } = await result.json();
  await page.goto("/");
  const card = page.locator(`[data-node-id="${node.id}"]`);
  await expect(card).toBeVisible();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: 200, y: 400, id: 1 },
      { x: 300, y: 400, id: 2 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: 170, y: 400, id: 1 },
      { x: 330, y: 400, id: 2 },
    ],
  });
  await expect(page.locator(".zoom-value")).toHaveText("233%");
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [{ x: 330, y: 400, id: 2 }],
  });
  const before = await page.locator(".canvas-world").getAttribute("style");
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 190, y: 420, id: 1 }],
  });
  await expect.poll(() => page.locator(".canvas-world").getAttribute("style")).not.toBe(before);
  await expect(page.locator(".zoom-value")).toHaveText("233%");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await page.reload();
  await page.getByRole("button", { name: "打开侧栏" }).click();
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await card.hover();
  const actions = page.getByRole("toolbar", { name: "节点操作" });
  const button = actions.getByRole("button", { name: "查看详情", exact: true });
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.getByLabel("节点标题")).toHaveValue("触控验证");
});

test("阅读布局消融：折叠元信息和增加阅读宽度分别减少占用与表格横向溢出", async ({
  page,
  request,
}) => {
  const title = `阅读消融-${randomUUID().slice(0, 4)}`;
  const row = `| ${Array.from({ length: 8 }, (_, i) => `证据字段${i}`).join(" | ")} |`;
  const result = await request.post(`${apiUrl}/api/v2/nodes`, {
    data: {
      kind: "text",
      title,
      text: `# 证据对照\n${row}\n| ${Array(8).fill("---").join(" | ")} |\n${row}\n\n> 保留可验证的来源。`,
      parentId: "canvas-e2e",
      position: { x: 80, y: 500, width: 240, height: 160 },
      idempotencyKey: randomUUID(),
    },
  });
  expect(result.ok()).toBe(true);
  const { node } = await result.json();
  await page.goto("/");
  await page.locator(`[data-node-id="${node.id}"]`).dblclick();
  const emptyMetadataCount = await page.locator(".detail-meta").count();
  expect(emptyMetadataCount).toBe(0);
  const table = page.getByRole("table");
  const overflow = () =>
    table.evaluate((el) => el.parentElement!.scrollWidth - el.parentElement!.clientWidth);
  const narrowOverflow = await overflow();
  await page.getByRole("button", { name: "展开阅读宽度" }).click();
  const wideOverflow = await overflow();
  expect(wideOverflow).toBeLessThan(narrowOverflow);
  const measurements = test.info().outputPath("ablation-measurements.json");
  writeFileSync(
    measurements,
    JSON.stringify({ emptyMetadataCount, narrowOverflow, wideOverflow }, null, 2),
  );
  await test
    .info()
    .attach("ablation-measurements", { path: measurements, contentType: "application/json" });
  await page.screenshot({ path: test.info().outputPath("reading-width.png") });
});
