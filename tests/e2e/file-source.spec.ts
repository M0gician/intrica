import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { API_URL, UI_URL } from "./environment.mjs";

test("文件目录导航单行显示，主目录与画布目录可直达，窄栏长名称可读且详情支持键盘关闭", async ({
  page,
}) => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "intrica-file-source-")));
  const directoryName = `shared-${"资料".repeat(28)}`;
  const directory = join(fixture, directoryName);
  const serverName = `资料服务器 · ${"LongServerName".repeat(18)}`;
  mkdirSync(directory);
  writeFileSync(join(directory, "report.txt"), "File source layout fixture\n");
  // Keep the real session, server identity, capabilities and file endpoints.
  // Only the display name is enlarged for the overflow case.
  await page.route(
    (url) => url.origin === UI_URL && url.pathname === "/api/v2/server",
    async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      const server = await response.json();
      await route.fulfill({ response, json: { ...server, name: serverName } });
    },
  );
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
    const sidebar = page.getByRole("complementary", { name: "工作区侧栏", exact: true });
    const tabs = sidebar.getByRole("navigation", { name: "侧栏工具", exact: true });
    await tabs.getByRole("button", { name: "文件", exact: true }).click();
    const files = sidebar.locator(".files-panel");
    const homeResponse = await page.request.get("/api/v2/workspace/files?path=~");
    expect(homeResponse.ok()).toBe(true);
    const home = (await homeResponse.json()).path;
    await expect(files.locator("button.file-location")).toHaveAttribute("title", home);
    await expect(files.locator("button.file-location")).toHaveText("用户主目录");
    await files.getByRole("button", { name: "查看文件位置", exact: true }).click();
    const initialDetails = page.getByRole("dialog", { name: "文件位置", exact: true });
    const workspace = initialDetails.getByRole("button", { name: "画布工作目录", exact: true });
    await expect(workspace).toBeVisible();
    const workspacePath = await workspace.getAttribute("title");
    expect(workspacePath).toBeTruthy();
    await expect(initialDetails).toContainText("Agent 可能使用各自的工作目录");
    await workspace.click();
    await expect(initialDetails).toHaveCount(0);
    await expect(files.locator("button.file-location")).toHaveAttribute("title", workspacePath!);
    await expect(files.locator("button.file-location")).toHaveText("画布工作目录");
    await files.getByRole("button", { name: "查看文件位置", exact: true }).click();
    await page
      .getByRole("dialog", { name: "文件位置", exact: true })
      .getByRole("button", { name: "用户主目录", exact: true })
      .click();
    await expect(files.locator("button.file-location")).toHaveAttribute("title", home);
    await files.locator("button.file-location").click();
    await files.getByRole("textbox", { name: "服务器目录路径", exact: true }).fill(directory);
    await files.getByRole("button", { name: "打开目录", exact: true }).click();
    await expect(files.getByRole("button", { name: "report.txt", exact: true })).toBeVisible();

    // Resize through the accessible separator rather than overriding product CSS.
    const separator = sidebar.getByRole("separator", { name: "调整侧栏宽度", exact: true });
    for (let step = 0; step < 4; step++) await separator.press("ArrowRight");
    await expect(separator).toHaveAttribute("aria-valuenow", "320");
    expect((await sidebar.boundingBox())!.width).toBeCloseTo(320, 0);

    const evidence: unknown[] = [];
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 800 });
      const source = files.getByRole("button", { name: "查看文件位置", exact: true });
      const location = files.locator("button.file-location");
      await expect(source).toHaveAttribute("title", `文件来源：${serverName}`);
      await expect(source).toHaveText("");
      await expect(location).toHaveText(directoryName);
      await expect(files).not.toContainText(UI_URL);
      await expect(files).not.toContainText(directory);
      await expect(files.locator(".execution-target")).toHaveCount(0);
      const geometry = await files.evaluate((element) => {
        const source = element.querySelector<HTMLElement>(".file-source-trigger")!;
        const chevron = source.querySelector("svg:last-child")!;
        const location = element.querySelector<HTMLElement>("button.file-location")!;
        const label = location.querySelector<HTMLElement>("span")!;
        const bounds = (node: Element) => {
          const rect = node.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            right: rect.right,
          };
        };
        return {
          panel: bounds(element),
          source: bounds(source),
          navigation: bounds(element.querySelector(".file-navigation")!),
          location: bounds(location),
          chevron: bounds(chevron),
          clippedLabel: label.scrollWidth > label.clientWidth,
          overflow: getComputedStyle(label).textOverflow,
          horizontalOverflow: element.scrollWidth - element.clientWidth,
        };
      });
      expect(geometry.source.right).toBeLessThanOrEqual(geometry.location.x);
      expect(
        Math.abs(
          geometry.source.y +
            geometry.source.height / 2 -
            (geometry.location.y + geometry.location.height / 2),
        ),
      ).toBeLessThanOrEqual(1);
      expect(geometry.navigation.height).toBeLessThanOrEqual(46);
      expect(
        Math.abs(
          geometry.source.y +
            geometry.source.height / 2 -
            (geometry.chevron.y + geometry.chevron.height / 2),
        ),
      ).toBeLessThanOrEqual(1);
      expect(geometry.source.right).toBeLessThanOrEqual(geometry.panel.right);
      expect(geometry.clippedLabel).toBe(true);
      expect(geometry.overflow).toBe("ellipsis");
      expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1);
      expect(geometry.panel.x).toBeGreaterThanOrEqual(0);
      expect(geometry.panel.right).toBeLessThanOrEqual(width);
      await expect(files.getByRole("button", { name: "刷新文件树", exact: true })).toBeInViewport();
      await expect(
        files.getByRole("button", { name: "添加当前目录到画布", exact: true }),
      ).toBeInViewport();

      const captions = [];
      for (const name of ["上一级目录", "刷新文件树", "添加当前目录到画布"]) {
        const button = files.getByRole("button", { name, exact: true });
        await button.hover();
        const caption = button.locator(".icon-caption");
        await expect(caption).toHaveCSS("opacity", "1");
        const bounds = (await caption.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(geometry.panel.x);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(geometry.panel.right);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(800);
        captions.push({ name, bounds });
      }
      await source.hover();
      await source.focus();
      await source.press("Enter");
      const details = page.getByRole("dialog", { name: "文件位置", exact: true });
      await expect(details).toBeVisible();
      await expect(details.getByText(serverName, { exact: true })).toBeVisible();
      await expect(details.getByText(UI_URL, { exact: true })).toBeVisible();
      await expect(details.getByText(directory, { exact: true })).toBeVisible();
      await expect(details.getByText("所在服务器", { exact: true })).toBeVisible();
      await expect(details.getByText("连接地址", { exact: true })).toBeVisible();
      await expect(details.getByText("当前目录", { exact: true })).toBeVisible();
      await expect(details).not.toContainText("此设备");
      const popover = (await details.boundingBox())!;
      expect(popover.x).toBeGreaterThanOrEqual(0);
      expect(popover.x + popover.width).toBeLessThanOrEqual(width);
      expect(popover.y + popover.height).toBeLessThanOrEqual(800);
      expect(await details.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(
        1,
      );
      const close = details.getByRole("button", { name: "关闭文件位置", exact: true });
      await close.hover();
      await expect(close.locator(".icon-caption")).toHaveCSS("opacity", "1");
      const closeCaption = (await close.locator(".icon-caption").boundingBox())!;
      expect(closeCaption.x).toBeGreaterThanOrEqual(popover.x);
      expect(closeCaption.x + closeCaption.width).toBeLessThanOrEqual(popover.x + popover.width);
      expect(closeCaption.y).toBeGreaterThanOrEqual(popover.y);
      expect(closeCaption.y + closeCaption.height).toBeLessThanOrEqual(popover.y + popover.height);
      await details.getByText("当前目录", { exact: true }).hover();
      const screenshot = test.info().outputPath(`file-source-${width}.png`);
      await page.screenshot({ path: screenshot });
      await test
        .info()
        .attach(`file-source-${width}`, { path: screenshot, contentType: "image/png" });
      await page.keyboard.press("Escape");
      await expect(details).toHaveCount(0);
      await expect(source).toBeFocused();
      await expect(sidebar).toBeVisible();
      await source.hover();
      await page.screenshot({ path: test.info().outputPath(`file-navigation-${width}.png`) });
      await files.locator(".file-navigation").screenshot({
        path: test.info().outputPath(`file-navigation-bar-${width}.png`),
      });

      await source.press("Space");
      await expect(details).toBeVisible();
      await tabs.getByRole("button", { name: "详情", exact: true }).click();
      await expect(details).toHaveCount(0);
      await expect(files).toBeHidden();
      await tabs.getByRole("button", { name: "文件", exact: true }).click();
      await expect(source).toBeVisible();
      await expect(details).toHaveCount(0);
      await expect(files).not.toContainText(directory);
      evidence.push({ viewportWidth: width, geometry, popover, captions, closeCaption });
    }
    await test.info().attach("file-source-measurements.json", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });
  } finally {
    await page.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("切换画布后不继承上一画布的目录节点目标", async ({ page, request }) => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "intrica-directory-scope-")));
  try {
    const canvases = [];
    for (const name of ["目录目标来源", "目录目标隔离"]) {
      const title = `${name}-${randomUUID().slice(0, 8)}`;
      const response = await request.post(`${API_URL}/api/v2/canvases`, {
        data: { title, idempotencyKey: randomUUID() },
      });
      expect(response.ok()).toBe(true);
      canvases.push({ title, id: (await response.json()).node.id as string });
    }
    const response = await request.post(`${API_URL}/api/v2/nodes`, {
      data: {
        kind: "text",
        parentId: canvases[0]!.id,
        title: "指定目录",
        resource: { type: "directory", path: fixture },
        position: { x: 80, y: 180, width: 240, height: 160 },
        idempotencyKey: randomUUID(),
      },
    });
    expect(response.ok()).toBe(true);
    const node = (await response.json()).node;
    await page.goto("/");
    await page.getByRole("button", { name: "切换画布", exact: true }).click();
    await page.getByRole("button", { name: canvases[0]!.title, exact: true }).click();
    await page.locator(`[data-node-id="${node.id}"]`).dblclick();
    await expect(page.locator("button.file-location")).toHaveAttribute("title", fixture);
    await page.getByRole("button", { name: "切换画布", exact: true }).click();
    await page.getByRole("button", { name: canvases[1]!.title, exact: true }).click();
    await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
    await page
      .getByRole("navigation", { name: "侧栏工具", exact: true })
      .getByRole("button", { name: "文件", exact: true })
      .click();
    const home = await request.get(`${API_URL}/api/v2/workspace/files?path=~`);
    expect(home.ok()).toBe(true);
    await expect(page.locator("button.file-location")).toHaveAttribute(
      "title",
      (await home.json()).path,
    );
    await expect(page.locator("button.file-location")).toHaveText("用户主目录");
    await page.getByRole("button", { name: "查看文件位置", exact: true }).click();
    await expect(
      page
        .getByRole("dialog", { name: "文件位置", exact: true })
        .getByRole("button", { name: "画布工作目录", exact: true }),
    ).toHaveAttribute("title", new RegExp(`/${canvases[1]!.id}/shared$`));
  } finally {
    await page.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});

import { randomUUID } from "node:crypto";
