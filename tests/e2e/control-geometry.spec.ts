import { readFileSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";

// Render the production menu structure with production styles, without an API or seed data.
const styles = [
  "../../apps/web/src/styles/base.css",
  "../../apps/web/src/styles/tokens.css",
  "../../apps/web/src/ui/controls.css",
  "../../apps/web/src/components/canvas-switcher.css",
  "../../apps/web/src/features/settings/settings.css",
].map((path) =>
  readFileSync(new URL(path, import.meta.url), "utf8").replace(/^@import[^;]+;/gm, ""),
);

async function render(page: Page, body: string) {
  await page.setContent(body);
  for (const content of styles) await page.addStyleTag({ content });
}

async function edges(menu: Locator, child: Locator) {
  const outer = (await menu.boundingBox())!;
  const inner = (await child.boundingBox())!;
  return {
    left: inner.x - outer.x,
    right: outer.x + outer.width - inner.x - inner.width,
    x: inner.x,
    width: inner.width,
  };
}

for (const width of [1280, 320]) {
  for (const gutter of [0, 14]) {
    test(`menu content stays centered at ${width}px with ${gutter}px scrollbar tracks`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 600 });
      await render(
        page,
        `
        <div class="canvas-menu ui-menu" style="position:fixed;left:12px;top:12px;max-height:560px">
          <div class="canvas-menu-controls">
            <div class="canvas-menu-header"><span>画布 <small>30</small></span><button>设置</button></div>
            <div class="canvas-server"><button class="canvas-server-trigger"><span class="canvas-server-label"><span>beta</span><small>http://10.102.45.141:3001</small></span></button></div>
            <div class="canvas-search-create"><input class="canvas-search" placeholder="搜索或新建画布…"><button class="ui-button" data-variant="primary">新建</button></div>
          </div>
          <ul class="canvas-menu-list">${Array.from(
            { length: 30 },
            (_, index) => `
            <li class="canvas-menu-row" ${index === 0 ? "data-current" : ""}>
              <button class="canvas-option"><span class="canvas-option-label"><span class="canvas-option-title">画布 ${index} ${"超长名称".repeat(30)}</span></span></button><button class="canvas-more">…</button>
            </li>`,
          ).join("")}</ul>
        </div>`,
      );
      // Explicit track widths exercise zero-width overlay geometry and real classic gutters
      // independently of the host OS scrollbar preference. Do not override gutter or padding.
      await page.addStyleTag({
        content: `
        .canvas-menu-controls, .canvas-menu-list, .canvas-edit-form, .canvas-server-list, .canvas-server-footer { scrollbar-width: auto; }
        ::-webkit-scrollbar { width: ${gutter}px; height: ${gutter}px; }
        ::-webkit-scrollbar-thumb { background: #999; border-radius: 7px; }
      `,
      });
      const menu = page.locator(".canvas-menu");
      const list = menu.locator(".canvas-menu-list");
      const search = menu.locator(".canvas-search-create");
      const trigger = menu.locator(".canvas-server-trigger");
      const records = [];
      for (const count of [30, 1, 0]) {
        await list.locator(".canvas-menu-row").evaluateAll((rows, count) => {
          rows.forEach((row, index) => {
            (row as HTMLElement).hidden = index >= count;
          });
        }, count);
        // Hidden rows must actually leave the flex layout in this isolated fixture.
        await list.locator("[hidden]").evaluateAll((rows) =>
          rows.forEach((row) => {
            (row as HTMLElement).style.display = "none";
          }),
        );
        const scroll = await list.evaluate((element) => ({
          gutter: element.getBoundingClientRect().width - element.clientWidth,
          leftGutter: element.clientLeft,
          overflows: element.scrollHeight > element.clientHeight,
          horizontalOverflow: element.scrollWidth - element.clientWidth,
        }));
        expect(scroll.gutter).toBe(gutter * 2);
        expect(scroll.leftGutter).toBe(gutter);
        expect(scroll.overflows).toBe(count === 30);
        expect(scroll.horizontalOverflow).toBe(0);
        const controls = await edges(menu, search);
        expect(controls.left).toBeCloseTo(controls.right, 1);
        expect(await edges(menu, trigger)).toEqual(controls);
        if (count) {
          const row = await edges(menu, list.locator(".canvas-menu-row").first());
          expect(row).toEqual(controls);
          const more = (await list.locator(".canvas-more").first().boundingBox())!;
          const listBox = (await list.boundingBox())!;
          expect(listBox.x + listBox.width - gutter - more.x - more.width).toBeGreaterThanOrEqual(
            8,
          );
        }
        records.push({ count, ...scroll, controls });
        if (count === 30) {
          await page.screenshot({ path: test.info().outputPath("canvas-menu.png") });
        }
      }
      expect(records[0]!.controls).toEqual(records[1]!.controls);
      expect(records[1]!.controls).toEqual(records[2]!.controls);
      await list.evaluate((element) => {
        element.outerHTML =
          '<form class="canvas-edit-form"><h2>重命名画布</h2><input aria-label="画布名称" value="我的画布"><div class="canvas-edit-actions"><button class="ui-button">取消</button><button class="ui-button" data-variant="primary">保存名称</button></div></form>';
      });
      expect(await edges(menu, menu.locator(".canvas-edit-form input"))).toEqual(
        records[0]!.controls,
      );

      await render(
        page,
        `
        <div class="canvas-server-menu ui-menu" style="position:fixed;left:12px;top:12px;width:296px;max-height:280px">
          <div class="canvas-server-list">${Array.from({ length: 30 }, (_, index) => `<button class="ui-button" data-variant="menu" role="menuitemradio"><span class="canvas-server-label"><span>服务器 ${index}</span><small>https://intrica.example.test</small></span></button>`).join("")}</div>
          <div class="canvas-server-footer"><button class="ui-button" data-variant="menu" role="menuitem">管理服务器</button></div>
        </div>`,
      );
      await page.addStyleTag({
        content: `
        .canvas-server-list, .canvas-server-footer { scrollbar-width: auto; }
        ::-webkit-scrollbar { width: ${gutter}px; height: ${gutter}px; }
        ::-webkit-scrollbar-thumb { background: #999; }
      `,
      });
      const servers = page.locator(".canvas-server-menu");
      const serverList = servers.locator(".canvas-server-list");
      const serverEdge = await edges(servers, serverList.locator("button").first());
      expect(serverEdge.left).toBeCloseTo(serverEdge.right, 1);
      expect(await edges(servers, servers.locator(".canvas-server-footer button"))).toEqual(
        serverEdge,
      );
      expect(
        await serverList.evaluate(
          (element) => element.getBoundingClientRect().width - element.clientWidth,
        ),
      ).toBe(gutter * 2);
      expect(
        await serverList.evaluate((element) => element.scrollHeight > element.clientHeight),
      ).toBe(true);
      await serverList.locator("button").last().focus();
      await expect(serverList.locator("button").last()).toBeInViewport();
      await expect(servers.locator(".canvas-server-footer button")).toBeInViewport();
      await page.screenshot({ path: test.info().outputPath("server-menu.png") });
      await test.info().attach("menu-geometries.json", {
        body: JSON.stringify({ width, gutter, records, serverEdge }, null, 2),
        contentType: "application/json",
      });
    });
  }
}

test("settings select chevrons are visually centered and retain native selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 600 });
  await render(
    page,
    `<div class="settings-content-inner" style="margin:12px;width:296px">
    <div class="settings-content">
      <label class="ui-field">语言<select class="ui-select" id="language"><option value="system">跟随系统</option><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
      <label class="ui-field">较高控件<select class="ui-select" id="tall" style="height:52px"><option></option></select></label>
      <label class="ui-field">不可用<select class="ui-select" disabled><option></option></select></label>
    </div></div>`,
  );
  for (const select of await page.locator("select").all()) {
    const screenshot = await select.screenshot();
    const geometry = await page.evaluate(async (data) => {
      const image = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${data}`)).blob(),
      );
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const ink = [];
      for (let y = 3; y < canvas.height - 3; y++) {
        for (let x = canvas.width - 28; x < canvas.width - 8; x++) {
          const index = (y * canvas.width + x) * 4;
          if (pixels[index]! < 210 && pixels[index + 1]! < 210 && pixels[index + 2]! < 210)
            ink.push({ x, y });
        }
      }
      return {
        height: canvas.height,
        inkPixels: ink.length,
        center:
          (Math.min(...ink.map((pixel) => pixel.y)) +
            Math.max(...ink.map((pixel) => pixel.y)) +
            1) /
          2,
      };
    }, screenshot.toString("base64"));
    expect(geometry.inkPixels).toBeGreaterThan(10);
    expect(Math.abs(geometry.center - geometry.height / 2)).toBeLessThanOrEqual(1);
  }
  const language = page.getByRole("combobox", { name: "语言" });
  await language.focus();
  await language.press("e");
  await expect(language).toHaveValue("en");
  await language.selectOption("zh-CN");
  await expect(language).toHaveValue("zh-CN");
  expect(await language.evaluate((element) => element.tagName)).toBe("SELECT");
  await page.screenshot({ path: test.info().outputPath("settings-selects.png") });
  await page.emulateMedia({ forcedColors: "active" });
  expect(await language.evaluate((element) => getComputedStyle(element).appearance)).toBe("auto");
});
