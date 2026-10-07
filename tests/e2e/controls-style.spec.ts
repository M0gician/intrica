import { expect, type Locator, test } from "@playwright/test";

async function appearance(button: Locator) {
  return button.evaluate((element) => {
    const style = getComputedStyle(element),
      bounds = element.getBoundingClientRect();
    return {
      background: style.backgroundColor,
      color: style.color,
      radius: Number.parseFloat(style.borderRadius),
      height: bounds.height,
      outline: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      focusVisible: element.matches(":focus-visible"),
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
    };
  });
}
function contrast(first: string, second: string) {
  const luminance = (value: string) => {
    const rgb = value
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map((part) => {
        const c = Number(part) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
    return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
  };
  const a = luminance(first),
    b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("shared controls retain readable pills, keyboard focus and menu geometry at desktop and narrow widths", async ({
  page,
}) => {
  const evidence = [];
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    const trigger = page.getByRole("button", { name: "切换画布", exact: true });
    await expect(page.getByRole("button", { name: /^(切换画布|Switch canvas)$/ })).toBeVisible();
    await page.keyboard.press("Control+,");
    const dialog = page.getByRole("main", { name: "设置", exact: true });
    await dialog.getByRole("button", { name: "服务器连接", exact: true }).click();
    const navigation = dialog.getByRole("navigation");
    expect(
      (await appearance(navigation.getByRole("button", { name: "通用", exact: true }))).background,
    ).toBe("rgba(0, 0, 0, 0)");
    expect(
      (await appearance(navigation.getByRole("button", { name: "服务器连接", exact: true })))
        .background,
    ).not.toBe("rgba(0, 0, 0, 0)");
    const primary = dialog.getByRole("button", { name: "添加服务器", exact: true });
    const secondary = dialog.getByRole("button", { name: "检查连接", exact: true });
    await expect(primary).toBeVisible();
    await expect(secondary).toBeVisible();
    for (const button of [primary, secondary]) {
      const style = await appearance(button);
      expect(style.radius).toBeGreaterThanOrEqual(style.height / 2);
      expect(style.height).toBeGreaterThanOrEqual(32);
      const bounds = (await button.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    }
    const ordinary = await appearance(primary);
    expect(ordinary.fontSize).toBe("13px");
    expect(ordinary.fontWeight).toBe("500");
    expect(contrast(ordinary.color, ordinary.background)).toBeGreaterThanOrEqual(4.5);
    await primary.hover();
    const hovered = await appearance(primary);
    expect(contrast(hovered.color, hovered.background)).toBeGreaterThanOrEqual(4.5);
    expect(hovered.background).not.toBe(ordinary.background);
    let releaseCheck!: () => void;
    const checking = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    await page.route("**/api/v2/settings/diagnostics", async (route) => {
      await checking;
      await route.continue();
    });
    await secondary.click();
    await expect(primary).toBeDisabled();
    const inactive = await appearance(primary);
    await primary.hover({ force: true });
    expect((await appearance(primary)).background).toBe(inactive.background);
    releaseCheck();
    await expect(primary).toBeEnabled();
    await page.unroute("**/api/v2/settings/diagnostics");
    await page.keyboard.press("Tab");
    await primary.focus();
    const focused = await appearance(primary);
    expect(focused.focusVisible).toBe(true);
    expect(focused.outline).not.toBe("none");
    expect(focused.outlineWidth).toBeGreaterThanOrEqual(2);
    await expect
      .poll(() => dialog.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
    const screenshot = test.info().outputPath(`server-controls-${width}.png`);
    await page.screenshot({ path: screenshot });
    await test
      .info()
      .attach(`server-controls-${width}`, { path: screenshot, contentType: "image/png" });

    // Remove the actual shared base rule from CSSOM, measure the lost pill style,
    // then restore it immediately. No selector imitation or screenshot hashes.
    const ablation = await primary.evaluate((element) => {
      const snapshot = () => ({
        radius: Number.parseFloat(getComputedStyle(element).borderRadius),
        background: getComputedStyle(element).backgroundColor,
        height: element.getBoundingClientRect().height,
      });
      const before = snapshot();
      const removed: Array<{ sheet: CSSStyleSheet; index: number; text: string }> = [];
      try {
        for (const sheet of Array.from(document.styleSheets)) {
          let rules: CSSRuleList;
          try {
            rules = sheet.cssRules;
          } catch {
            continue;
          }
          for (let index = rules.length - 1; index >= 0; index--) {
            const rule = rules[index] as CSSStyleRule;
            if (
              rule.style?.getPropertyValue("--button-background").trim() !== "var(--control-soft)"
            )
              continue;
            removed.push({ sheet, index, text: rule.cssText });
            sheet.deleteRule(index);
          }
        }
        return { before, withoutSharedBase: snapshot(), removedRules: removed.length };
      } finally {
        for (const item of removed.reverse()) item.sheet.insertRule(item.text, item.index);
      }
    });
    expect(ablation.removedRules).toBeGreaterThan(0);
    expect(ablation.withoutSharedBase.radius).toBeLessThan(ablation.withoutSharedBase.height / 2);
    expect((await appearance(primary)).radius).toBe(ablation.before.radius);

    await dialog.getByRole("button", { name: "返回画布", exact: true }).click();
    await trigger.click();
    const menu = page.locator(".canvas-menu");
    await expect(menu).toBeVisible();
    const create = await appearance(menu.getByRole("button", { name: "新建画布", exact: true }));
    expect(create.radius).toBeGreaterThanOrEqual(create.height / 2);
    expect(contrast(create.color, create.background)).toBeGreaterThanOrEqual(4.5);
    const search = menu.getByRole("textbox", { name: "搜索或新建画布", exact: true });
    await search.press("ArrowDown");
    const option = menu.locator(".canvas-option").first();
    await expect(option).toBeFocused();
    const row = await appearance(option);
    expect(row.radius).toBeLessThan(row.height / 2);
    const bounds = (await menu.boundingBox())!,
      entry = (await trigger.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y).toBeGreaterThanOrEqual(entry.y + entry.height);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(800);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    evidence.push({
      width,
      ordinary,
      hovered,
      focused,
      disabledBackground: inactive.background,
      ablation,
      menu: bounds,
    });
  }
  await test.info().attach("shared-control-measurements.json", {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  });
});
