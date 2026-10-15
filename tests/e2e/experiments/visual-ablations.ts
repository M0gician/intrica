import { writeFileSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";

// Enabled only by the isolated visual experiment entry point.
export const visualAblations = process.env.INTRICA_VISUAL_ABLATIONS === "1";

export async function ablateComposer(page: Page, toolbar: Locator) {
  const before = (await toolbar.locator(".context-usage-ring").boundingBox())!.x;
  const ablated = await page.addStyleTag({
    content: ".agent-composer-toolbar > .context-usage-ring { margin-left: 0; }",
  });
  const shift = before - (await toolbar.locator(".context-usage-ring").boundingBox())!.x;
  expect(shift).toBeGreaterThan(100);
  await ablated.evaluate((el) => el.parentNode?.removeChild(el));
  return shift;
}

export async function ablateBookmark(page: Page, card: Locator, gaps: unknown) {
  const ablated = await page.addStyleTag({
    content:
      ".bookmark-card-preview { flex: none; aspect-ratio: 16 / 10; height: 124px; align-self: flex-start; }",
  });
  const gap = await card.evaluate(
    (el) =>
      el.querySelector(".node-card-body")!.getBoundingClientRect().right -
      el.querySelector(".bookmark-card-preview")!.getBoundingClientRect().right,
  );
  expect(gap).toBeGreaterThan(30);
  await ablated.evaluate((el) => el.parentNode?.removeChild(el));
  await test.info().attach("preview-geometry", {
    body: JSON.stringify({ gaps, ablatedRightGap: gap }, null, 2),
    contentType: "application/json",
  });
}

export async function ablateHistory(page: Page) {
  const measurePan = async () => {
    await page.evaluate(() => {
      const w = window as any;
      w.panFrames = [];
      w.panStart = performance.now();
      let last = w.panStart;
      const frame = (now: number) => {
        w.panFrames.push(now - last);
        last = now;
        if (now - w.panStart < 1200) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    await page.keyboard.down("Space");
    await page.mouse.move(220, 430);
    await page.mouse.down();
    await page.mouse.move(440, 540, { steps: 35 });
    await page.mouse.up();
    await page.keyboard.up("Space");
    await page.waitForTimeout(1250);
    return page.evaluate(() => {
      const values = (window as any).panFrames.slice(1).sort((a: number, b: number) => a - b);
      return {
        p95: values[Math.floor(values.length * 0.95)],
        frames: values.length,
        dom: document.querySelectorAll(".agent-event *").length,
      };
    });
  };
  const bounded = await measurePan();
  // Ablate page offloading by restoring thousands of mounted message rows, then restore the UI.
  await page.locator(".agent-activity").evaluate((el) => {
    const row = el.querySelector(".agent-event")!;
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 2420; i++) {
      const copy = row.cloneNode(true) as HTMLElement;
      copy.dataset.ablation = "history";
      copy.style.contentVisibility = "visible";
      fragment.append(copy);
    }
    el.append(fragment);
  });
  const mounted = await measurePan();
  await page.locator('[data-ablation="history"]').evaluateAll((nodes) =>
    nodes.forEach((node) => {
      node.remove();
    }),
  );
  expect(mounted.dom).toBeGreaterThan(bounded.dom * 10);
  writeFileSync(
    test.info().outputPath("canvas-ablation.json"),
    JSON.stringify({ bounded, mounted }, null, 2),
  );
}

export async function ablatePortraits(page: Page, whiteStrokes: number) {
  await page.evaluate(() => {
    const sheet = document.createElement("div");
    sheet.id = "portrait-sheet";
    sheet.style.cssText =
      "display:grid;grid-template-columns:repeat(3,220px);gap:18px;padding:24px;background:#f6f3ed;width:744px";
    for (const card of Array.from(document.querySelectorAll(".agent-photo-card"))) {
      const clone = card.cloneNode(true) as HTMLElement;
      clone.style.cssText =
        "height:280px;padding:8px;background:white;border:1px solid #e3dfd6;border-radius:8px";
      sheet.appendChild(clone);
    }
    document.body.replaceChildren(sheet);
    document.body.style.overflow = "auto";
  });
  await page.setViewportSize({ width: 760, height: 1860 });
  await page.screenshot({ path: test.info().outputPath("warm-portraits.png"), fullPage: true });
  // Restore the rejected uniform pale feature color as a visual ablation, without changing stored data.
  await page.evaluate(() => {
    for (const el of Array.from(
      document.querySelectorAll(
        '[data-feature="brows"], [data-feature="nose"] path, [data-feature="mouth"] path, [data-feature="glasses"]',
      ),
    )) {
      el.setAttribute("stroke", "#fff8ee");
      el.setAttribute("stroke-width", "2.8");
    }
  });
  await page.screenshot({
    path: test.info().outputPath("white-line-ablation.png"),
    fullPage: true,
  });
  writeFileSync(
    test.info().outputPath("portrait-review.json"),
    JSON.stringify(
      {
        portraits: 18,
        skinTones: 6,
        whiteFeatureStrokes: whiteStrokes,
        method:
          "Production card DOM. Comparison changes only face and frame strokes to the rejected pale color.",
      },
      null,
      2,
    ),
  );
}
