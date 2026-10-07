import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateNodeRequest, Node } from "@intrica/contracts";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

const api = API_URL;
async function board(request: APIRequestContext, page: Page, title: string) {
  const response = await request.post(`${api}/api/v2/canvases`, {
    data: { title, idempotencyKey: randomUUID() },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).node.id as string;
  return {
    create: async (data: Partial<CreateNodeRequest>) => {
      const response = await request.post(`${api}/api/v2/nodes`, {
        data: {
          kind: "text",
          parentId: id,
          position: { x: 80, y: 180, width: 240, height: 160 },
          ...data,
          idempotencyKey: randomUUID(),
        },
      });
      expect(response.ok()).toBe(true);
      return (await response.json()).node as Node;
    },
    open: async () => {
      await page.goto("/");
      await page.getByLabel("切换画布").click();
      await page.getByRole("button", { name: title, exact: true }).click();
    },
  };
}

test("目录双击直达树，切换目录清除搜索和旧文件预览", async ({ page, request }) => {
  const first = realpathSync(mkdtempSync(join(tmpdir(), "intrica-dir-a-")));
  const second = realpathSync(mkdtempSync(join(tmpdir(), "intrica-dir-b-")));
  writeFileSync(join(first, "证据.md"), "# 原始证据\n用于目录预览验证");
  writeFileSync(join(second, "后续.md"), "另一目录");
  try {
    const fixture = await board(request, page, "目录专用视图");
    const a = await fixture.create({
      title: "原始资料",
      resource: { type: "directory", path: first },
    });
    const b = await fixture.create({
      title: "后续资料",
      resource: { type: "directory", path: second },
      position: { x: 380, y: 180, width: 240, height: 160 },
    });
    await fixture.open();
    const card = page.locator(`[data-node-id="${a.id}"]`);
    await expect(card).toHaveClass(/directory-card/);
    await card.dblclick();
    await expect(page.locator("button.file-location")).toHaveAttribute("title", first);
    await page.getByLabel("搜索目录树").fill("证据");
    await page.getByRole("button", { name: "证据.md", exact: true }).click();
    await expect(page.locator(".file-preview")).toContainText("原始证据");
    await page.locator(`[data-node-id="${b.id}"]`).dblclick();
    await expect(page.locator("button.file-location")).toHaveAttribute("title", second);
    await expect(page.getByLabel("搜索目录树")).toHaveValue("");
    await expect(page.locator(".file-preview")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "后续.md", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("directory-view.png") });
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("图片卡片以图为主，原图缩放与拖动保持画布不动", async ({ page, request }) => {
  const fixture = await board(request, page, "图片专用视图");
  const image = await request.post(`${api}/api/v2/assets`, {
    multipart: {
      idempotencyKey: randomUUID(),
      file: {
        name: "证据.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#ddd2bd"/><path d="M0 800 600 100 1200 800" fill="#526e62"/><circle cx="960" cy="160" r="80" fill="#dfb960"/></svg>',
        ),
      },
    },
  });
  expect(image.ok()).toBe(true);
  const asset = await image.json();
  const node = await fixture.create({
    kind: "image",
    title: "现场照片",
    alt: "远山和夕阳",
    assetId: asset.assetId,
    assetVersion: asset.assetVersion,
    position: { x: 80, y: 180, width: 300, height: 230 },
  });
  await fixture.open();
  const card = page.locator(`[data-node-id="${node.id}"]`);
  await expect(card).toHaveClass(/image-card/);
  await expect(card.locator(".node-card-summary")).toHaveCount(0);
  await card.dblclick();
  await expect(page.locator(".image-dimensions")).toHaveText("1200 × 800 px");
  await page.getByRole("button", { name: "1:1", exact: true }).click();
  const stage = page.getByRole("region", { name: "图片预览", exact: true });
  const transform = await page.locator(".canvas-world").getAttribute("style");
  await stage.hover();
  await page.mouse.wheel(100, 200);
  await expect.poll(() => stage.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.locator(".canvas-world").getAttribute("style")).toBe(transform);
  await page.getByRole("button", { name: "适应图片", exact: true }).click();
  await expect
    .poll(() => stage.evaluate((el) => el.scrollWidth - el.clientWidth))
    .toBeLessThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath("image-view.png") });
});

test("文件预览复制 PNG 到本机剪贴板，GIF 明确复制静态帧", async ({ page, request, context }) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "intrica-image-copy-")));
  writeFileSync(
    join(directory, "pixel.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  writeFileSync(
    join(directory, "frame.gif"),
    Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
  );
  try {
    const fixture = await board(request, page, "图片复制验收");
    const folder = await fixture.create({
      title: "图片文件",
      resource: { type: "directory", path: directory },
    });
    await fixture.open();
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.locator(`[data-node-id="${folder.id}"]`).dblclick();
    await page.getByRole("button", { name: "pixel.png", exact: true }).click();
    await expect
      .poll(() =>
        page.locator(".file-preview img").evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBe(1);
    await page.getByRole("button", { name: "复制图片", exact: true }).click();
    await expect(page.locator(".file-preview").getByRole("status")).toContainText("图片已复制");
    expect(await page.evaluate(async () => (await navigator.clipboard.read())[0]!.types)).toContain(
      "image/png",
    );
    await page.getByRole("button", { name: "返回目录", exact: true }).click();
    await page.getByRole("button", { name: "frame.gif", exact: true }).click();
    await expect(page.getByRole("button", { name: "复制静态帧", exact: true })).toBeVisible();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ToDo 完整展示、勾选持久化、复制保留状态和新建入口", async ({ page, request }) => {
  const fixture = await board(request, page, "待办便签");
  const text = "核对原始材料，并记录本轮调查进度。\n".repeat(10).trim();
  const node = await fixture.create({
    kind: "todo",
    title: "核对来源",
    text,
    todo: { completed: false },
  });
  await fixture.open();
  await page.getByRole("button", { name: "适应画布", exact: true }).click();
  const card = page.locator(`[data-node-id="${node.id}"]`);
  await expect(card).toHaveClass(/todo-card/);
  expect(
    await card.locator(".node-card-body").evaluate((el) => el.scrollHeight - el.clientHeight),
  ).toBeLessThanOrEqual(1);
  await card.getByRole("checkbox").check();
  await expect
    .poll(async () => {
      const response = await (await request.get(`${api}/api/v2/nodes/${node.id}/content`)).json();
      return response.node.todo.completed;
    })
    .toBe(true);
  await page.reload();
  await expect(card.getByRole("checkbox")).toBeChecked();
  await card.locator("header").dblclick();
  await expect(page.getByRole("textbox", { name: "待办标题", exact: true })).toHaveValue(
    "核对来源",
  );
  await page.getByRole("button", { name: "新建节点", exact: true }).click();
  await page.getByRole("menuitem", { name: "待办", exact: true }).click();
  await expect(page.locator(".todo-card")).toHaveCount(2);
  await page.screenshot({ path: test.info().outputPath("todo-view.png") });
});
