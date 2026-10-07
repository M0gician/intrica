import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

const api = API_URL;
test("1000 画布：搜索、键盘选择、逐项重命名删除、失败保留与统一搜索新建", async ({
  page,
  request,
}) => {
  const boards: Array<{ id: string; title: string }> = [];
  for (let offset = 0; offset < 1000; offset += 20) {
    boards.push(
      ...(await Promise.all(
        Array.from({ length: 20 }, async (_, i) => {
          const response = await request.post(`${api}/api/v2/canvases`, {
            data: {
              title: `项目 ${String(offset + i).padStart(4, "0")} · Research`,
              idempotencyKey: randomUUID(),
            },
          });
          expect(response.ok()).toBe(true);
          return (await response.json()).node;
        }),
      )),
    );
  }
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "切换画布", exact: true });
  const menu = page.getByRole("dialog", { name: "画布切换", exact: true });
  await expect(trigger).toBeVisible();
  const started = Date.now();
  await trigger.click();
  await expect(page.getByRole("textbox", { name: "搜索或新建画布" })).toBeFocused();
  const openedMs = Date.now() - started;
  await expect(page.getByRole("button", { name: "删除当前画布", exact: true })).toHaveCount(0);
  const geometry = await menu.evaluate((el) => {
    const r = el.getBoundingClientRect(),
      list = el.querySelector(".canvas-menu-list")!;
    return {
      width: r.width,
      bottom: r.bottom,
      rows: list.children.length,
      scrolls: list.scrollHeight > list.clientHeight,
    };
  });
  expect(geometry.rows).toBeGreaterThanOrEqual(1000);
  expect(geometry.scrolls).toBe(true);
  expect(geometry.bottom).toBeLessThanOrEqual(600);
  await expect(page.getByRole("textbox", { name: "搜索或新建画布" })).toBeInViewport();
  await menu.getByRole("button", { name: boards[999]!.title, exact: true }).click();
  await expect(trigger).toContainText("0999");
  await trigger.click();
  await expect(menu.locator('[aria-current="page"]')).toBeInViewport({ ratio: 0.9 });
  const search = page.getByRole("textbox", { name: "搜索或新建画布" });
  const searchStarted = Date.now();
  await search.fill("ＲｅＳｅＡｒＣｈ");
  await expect(menu.locator(".canvas-menu-row")).toHaveCount(1000);
  await search.fill("0999");
  await expect(menu.locator(".canvas-menu-row")).toHaveCount(1);
  const searchMs = Date.now() - searchStarted;
  await search.press("ArrowDown");
  await expect(menu.getByRole("button", { name: boards[999]!.title, exact: true })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(menu.getByRole("button", { name: `${boards[999]!.title}的更多操作` })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "重命名", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(menu).toBeVisible();
  await search.fill("0012");
  await menu.getByRole("button", { name: `${boards[12]!.title}的更多操作` }).click();
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  const name = page.getByRole("textbox", { name: "画布名称", exact: true });
  await expect(name).toBeFocused();
  await name.fill("0012 · 归档调查");
  const renameUrl = `**/api/v2/canvases/${boards[12]!.id}`;
  await page.route(renameUrl, (route) =>
    route.fulfill({ status: 503, json: { error: { code: "INTERNAL", message: "暂时不可用" } } }),
  );
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(menu.getByRole("alert")).toContainText("输入已保留");
  await expect(name).toHaveValue("0012 · 归档调查");
  await page.unroute(renameUrl);
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(menu.getByRole("button", { name: "0012 · 归档调查", exact: true })).toBeVisible();
  await expect(trigger).toContainText("0999");
  await page.locator(".toast").getByRole("button", { name: "撤销", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get(`${api}/api/v2/nodes/${boards[12]!.id}/content`)).json()).node
          .title,
    )
    .toBe(boards[12]!.title);
  await trigger.click();
  await search.fill("0013");
  await menu.getByRole("button", { name: `${boards[13]!.title}的更多操作` }).click();
  await page.getByRole("menuitem", { name: "删除画布", exact: true }).click();
  await expect(page.getByRole("form", { name: "删除画布确认" })).toContainText(boards[13]!.title);
  await page.getByRole("button", { name: "确认删除画布", exact: true }).click();
  await expect(menu.locator(".canvas-menu-row")).toHaveCount(0);
  await expect(trigger).toContainText("0999");
  await page.locator(".toast").getByRole("button", { name: "撤销", exact: true }).click();
  await expect
    .poll(async () => (await request.get(`${api}/api/v2/nodes/${boards[13]!.id}/content`)).status())
    .toBe(200);
  await trigger.click();
  await page.getByRole("textbox", { name: "搜索或新建画布" }).fill("规模测试新画布");
  await page.route("**/api/v2/canvases", (route) =>
    route.fulfill({ status: 503, json: { error: { code: "INTERNAL", message: "暂时不可用" } } }),
  );
  await page.getByRole("button", { name: "新建画布", exact: true }).click();
  await expect(menu.getByRole("alert")).toContainText("名称已保留");
  await expect(page.getByRole("textbox", { name: "搜索或新建画布" })).toHaveValue("规模测试新画布");
  await page.unroute("**/api/v2/canvases");
  await page.getByRole("button", { name: "新建画布", exact: true }).click();
  await expect(trigger).toContainText("规模测试新画布");
  await page.reload();
  await expect(trigger).toContainText("规模测试新画布");
  await page.setViewportSize({ width: 360, height: 480 });
  await trigger.click();
  await expect(menu.locator('[aria-current="page"]')).toBeInViewport({ ratio: 0.9 });
  await search.fill("rEsEaRcH");
  await expect(menu.locator(".canvas-menu-row")).toHaveCount(1000);
  await search.press("ArrowDown");
  const options = menu.locator(".canvas-option");
  await expect(options.first()).toBeFocused();
  await page.keyboard.press("End");
  // Concurrent seed requests need not commit in their numeric title order.
  await expect(options.last()).toBeFocused();
  await expect(page.getByRole("textbox", { name: "搜索或新建画布" })).toBeInViewport();
  const narrow = await menu.boundingBox();
  const entry = await trigger.boundingBox();
  expect(narrow!.x).toBeGreaterThanOrEqual(0);
  expect(narrow!.y).toBeGreaterThanOrEqual(entry!.y + entry!.height);
  expect(narrow!.x + narrow!.width).toBeLessThanOrEqual(360);
  expect(narrow!.y + narrow!.height).toBeLessThanOrEqual(480);
  await page.screenshot({ path: test.info().outputPath("1000-canvases-narrow.png") });
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  writeFileSync(
    test.info().outputPath("menu-measurements.json"),
    JSON.stringify(
      {
        seededCanvases: 1000,
        openedMs,
        searchMs,
        geometry,
        narrow,
        note: "Single local E2E observation including driver latency, not a human usability study.",
      },
      null,
      2,
    ),
  );
});

test("500 字名称：窄屏布局、滚动条间距、统一输入与中文输入法", async ({ page, request }) => {
  const longChinese = `超长名称${"研究画布".repeat(124)}`;
  const longAscii = `LongName${"X".repeat(492)}`;
  for (const title of [
    longChinese,
    longAscii,
    ...Array.from({ length: 12 }, (_, i) => `长名验证 ${i}`),
  ]) {
    const response = await request.post(`${api}/api/v2/canvases`, {
      data: { title, idempotencyKey: randomUUID() },
    });
    expect(response.ok()).toBe(true);
  }
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "切换画布", exact: true });
  const menu = page.getByRole("dialog", { name: "画布切换", exact: true });
  const search = menu.getByRole("textbox", { name: "搜索或新建画布", exact: true });
  const gaps: unknown[] = [];
  for (const width of [800, 320]) {
    await page.setViewportSize({ width, height: 480 });
    await trigger.click();
    await expect(search).toBeFocused();
    await expect(menu.getByRole("textbox")).toHaveCount(1);
    // Check real row bounds before filtering, while the native scrollbar is present.
    const gap = await menu.locator(".canvas-menu-list").evaluate((list) => {
      const r = list.getBoundingClientRect();
      const more = list.querySelector(".canvas-more")!.getBoundingClientRect();
      return {
        width: r.width,
        gutterGap: r.left + list.clientLeft + list.clientWidth - more.right,
        scrolls: list.scrollHeight > list.clientHeight,
      };
    });
    expect(gap.scrolls).toBe(true);
    expect(gap.gutterGap).toBeGreaterThanOrEqual(8);
    const searchBox = await menu.locator(".canvas-search-create").boundingBox();
    const rowBox = await menu.locator(".canvas-menu-row").first().boundingBox();
    const serverBox = await menu.locator(".canvas-server-trigger").boundingBox();
    const menuBox = (await menu.boundingBox())!;
    expect(rowBox!.x - menuBox.x).toBeCloseTo(
      menuBox.x + menuBox.width - rowBox!.x - rowBox!.width,
      1,
    );
    expect(rowBox!.x).toBeCloseTo(searchBox!.x, 1);
    expect(rowBox!.width).toBeCloseTo(searchBox!.width, 1);
    expect(serverBox!.width).toBeCloseTo(searchBox!.width, 1);
    gaps.push({ viewportWidth: width, ...gap });
    for (const title of [longChinese, longAscii]) {
      await search.fill(title);
      const choice = menu.getByRole("button", { name: title, exact: true });
      const more = menu.getByRole("button", { name: `${title}的更多操作`, exact: true });
      await expect(choice).toBeVisible();
      const filteredRow = await choice.locator("..").boundingBox();
      expect(filteredRow!.width).toBeCloseTo(searchBox!.width, 1);
      await expect(more).toBeInViewport();
      const text = choice.locator(".canvas-option-title");
      expect(await text.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      const textBox = await text.boundingBox();
      const moreBox = await more.boundingBox();
      expect(textBox!.x + textBox!.width).toBeLessThanOrEqual(moreBox!.x);
      await expect(choice).toHaveAttribute("title", title);
      await more.click();
      await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
      await expect(menu.getByRole("textbox", { name: "画布名称", exact: true })).toHaveValue(title);
      await expect(menu.getByRole("button", { name: "保存名称", exact: true })).toBeInViewport();
      expect(await menu.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await menu.getByRole("button", { name: "取消", exact: true }).click();
    }
    await search.fill(longChinese);
    await expect(search).toHaveValue(longChinese);
    await search.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toHaveAttribute("title", longChinese);
    const bounds = await trigger.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  }
  await trigger.click();
  await search.fill(longAscii);
  await menu.getByRole("button", { name: `${longAscii}的更多操作`, exact: true }).click();
  await page.getByRole("menuitem", { name: "删除画布", exact: true }).click();
  await expect(menu.getByRole("button", { name: "确认删除画布", exact: true })).toBeInViewport();
  await expect(menu.locator(".canvas-edit-title")).toHaveText(longAscii);
  await page.screenshot({ path: test.info().outputPath("long-title-delete.png") });
  await menu.getByRole("button", { name: "取消", exact: true }).click();
  const createdTitle = `输入法验证${"A".repeat(495)}`;
  await search.fill(createdTitle);
  await search.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute("title", longChinese);
  await search.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toHaveAttribute("title", createdTitle);
  await trigger.click();
  await search.fill(createdTitle);
  await page.screenshot({ path: test.info().outputPath("long-title-search.png") });
  await menu.getByRole("button", { name: `${createdTitle}的更多操作`, exact: true }).click();
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  const renamed = `已重命名${"新".repeat(496)}`;
  await menu.getByRole("textbox", { name: "画布名称", exact: true }).fill("");
  await menu
    .getByRole("textbox", { name: "画布名称", exact: true })
    .pressSequentially("typed name");
  await expect(menu.getByRole("textbox", { name: "画布名称", exact: true })).toHaveValue(
    "typed name",
  );
  await menu.getByRole("textbox", { name: "画布名称", exact: true }).fill(renamed);
  await menu.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(trigger).toHaveAttribute("title", renamed);
  await page.reload();
  await expect(trigger).toHaveAttribute("title", renamed);
  writeFileSync(
    test.info().outputPath("long-title-measurements.json"),
    JSON.stringify(
      {
        titleLengths: [longChinese.length, longAscii.length, createdTitle.length, renamed.length],
        gaps,
        verified: [
          "single input",
          "IME Enter ignored",
          "Enter selects or creates",
          "500 character rename persists",
          "long title actions stay visible",
        ],
      },
      null,
      2,
    ),
  );
});
