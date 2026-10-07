import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const webRoot = fileURLToPath(new URL("../../apps/web", import.meta.url));
const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div>
<script type="module">
import React from "react";
import {createRoot} from "react-dom/client";
import {DesktopUpdateNotice} from "/src/features/settings/DesktopUpdateNotice.tsx";
import {DesktopUpdateProvider, DesktopUpdateBadge} from "/src/features/settings/desktop-update-state.tsx";
import {BottomBar} from "/src/components/BottomBar.tsx";
import {TaskBar} from "/src/components/TaskBar.tsx";
import "/src/styles.css";
const h = React.createElement, noop = () => {};
function Fixture() {
  const [layout, setLayout] = React.useState({selected:false, task:false, toast:false, sidebar:0});
  window.setNoticeLayout = setLayout;
  return h(DesktopUpdateProvider, null,
    h("input", {id:"agent-prompt", "aria-label":"Agent prompt", style:{position:"fixed",left:16,top:16}}),
    h("button", {id:"settings-entry", style:{position:"fixed",right:16,top:16}}, "Settings", h(DesktopUpdateBadge)),
    h(DesktopUpdateNotice),
    h("div", {className:"canvas-viewport"},
      h("div", {className:"bottom-region", style:{"--workspace-width":layout.sidebar+"px"}},
        h(BottomBar, {availability:{selectionCount:layout.selected?2:0, blockedPdfNodeIds:layout.pdf?["pdf"]:[], actions:["expand","deepen","compress","link"].map(id=>({id,label:id,hint:id,enabled:true}))}, onReadPdf:noop,
          moreOpen:Boolean(layout.more), canInspect:true, agentRunState:"working", onAgentRun:action=>window.bottomCalls.push(action),
          onAction:noop,onToggleMore:()=>setLayout(previous=>({...previous,more:!previous.more})),onDelete:noop,onCopy:noop,onInspect:noop}),
        h(TaskBar, {chips:layout.task?Array.from({length:layout.copies??1},(_,index)=>({operation:{id:"fixture-task-"+index,type:"expand",status:layout.candidate?"candidate":"running"},queuePosition:null,segmentCount:4,candidateCount:0})):[],
          onCancel:noop,onAcceptAll:id=>window.taskCalls.push(id),onReviewOne:noop,onDiscard:noop,onRetry:noop,onShowReason:noop,onUndo:noop,onClose:noop}),
        layout.toast && h("div", {className:"toast"}, "Task status")),
      layout.panel && h("aside", {className:"workspace-panel", "aria-label":"Sidebar fixture", style:{width:layout.sidebar+"px"}}, "Sidebar fixture")));
}
createRoot(document.getElementById("root")).render(h(Fixture));
</script></body></html>`;

test("desktop update notice defers to real canvas controls at narrow and wide widths without dismissing or moving focus", async () => {
  const server = await createServer({
    root: webRoot,
    configFile: `${webRoot}/vite.config.ts`,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "isolated-update-layout",
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__update_layout") return next();
            try {
              response.setHeader("Content-Type", "text/html");
              response.end(await vite.transformIndexHtml(request.url, html));
            } catch (error) {
              next(error);
            }
          });
        },
      },
    ],
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage({ locale: "zh-CN", reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("intrica:language", "zh-CN");
      window.updateCalls = [];
      window.bottomCalls = [];
      window.taskCalls = [];
      window.intricaDesktop = {
        updates: {
          state: async () => ({
            packaged: true,
            notice: { version: "0.3.0", status: "ready", seen: false },
          }),
          dismissNotice: async () => {
            window.updateCalls.push("dismiss");
            return { notice: null };
          },
          open: async () => window.updateCalls.push("open"),
        },
      };
    });
    const address = server.httpServer.address();
    await page.goto(`http://127.0.0.1:${address.port}/__update_layout`);
    const notice = page.locator(".desktop-update-notice");
    await notice.waitFor({ state: "visible" });
    const evidenceDir = fileURLToPath(
      new URL("./test-results/desktop-update-layout", import.meta.url),
    );
    await mkdir(evidenceDir, { recursive: true });
    for (const width of [320, 800, 1440]) {
      await page.setViewportSize({ width, height: 600 });
      await page.locator("#agent-prompt").focus();
      const box = await notice.boundingBox();
      assert.ok(
        box && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 600,
        `idle notice must fit viewport ${width}`,
      );
      for (const active of [
        { selected: true, task: false, toast: false },
        { selected: false, task: true, toast: false },
        { selected: false, task: false, toast: true },
      ]) {
        await page.evaluate((layout) => window.setNoticeLayout({ ...layout, sidebar: 0 }), active);
        await notice.waitFor({ state: "hidden" });
        assert.equal(
          await page.locator("#settings-entry .desktop-update-badge").isVisible(),
          true,
          "update remains discoverable while the passive notice is deferred",
        );
        assert.equal(
          await page
            .locator("#agent-prompt")
            .evaluate((element) => document.activeElement === element),
          true,
        );
        const overlap = await page.evaluate(() => {
          const n = document.querySelector(".desktop-update-notice"),
            r = n.getBoundingClientRect();
          return [...document.querySelectorAll(".bottom-controls,.task-bar,.toast")].some(
            (control) => {
              const c = control.getBoundingClientRect();
              return (
                r.width > 0 &&
                r.height > 0 &&
                r.x < c.right &&
                r.right > c.x &&
                r.y < c.bottom &&
                r.bottom > c.y
              );
            },
          );
        });
        assert.equal(overlap, false, `notice must not overlap active controls at ${width}`);
        if (width === 800 && active.selected)
          await page.screenshot({ path: `${evidenceDir}/800-active-controls.png` });
        await page.evaluate(() =>
          window.setNoticeLayout({ selected: false, task: false, toast: false, sidebar: 0 }),
        );
        await notice.waitFor({ state: "visible" });
      }
      await page.screenshot({ path: `${evidenceDir}/${width}-idle-notice.png` });
      const sidebar = width >= 1440 ? 480 : width >= 800 ? 320 : 0;
      await page.evaluate(
        (sidebar) =>
          window.setNoticeLayout({
            selected: true,
            task: true,
            candidate: true,
            pdf: true,
            toast: true,
            sidebar,
            copies: 3,
          }),
        sidebar,
      );
      await page.locator(".task-chip-candidate").first().waitFor({ state: "visible" });
      const layout = await page.evaluate(() => {
        const regions = [...document.querySelectorAll(".bottom-controls,.task-bar,.toast")].map(
          (element) => {
            const rect = element.getBoundingClientRect();
            return {
              name: element.className,
              x: rect.x,
              y: rect.y,
              right: rect.right,
              bottom: rect.bottom,
            };
          },
        );
        const buttons = [...document.querySelectorAll(".task-chip button")].map((element) => {
          const rect = element.getBoundingClientRect(),
            text = document.createRange();
          text.selectNodeContents(element);
          const label = text.getBoundingClientRect();
          return {
            label: element.textContent,
            rect: { x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom },
            text: { x: label.x, right: label.right, y: label.y, bottom: label.bottom },
          };
        });
        return { regions, buttons };
      });
      for (const region of layout.regions)
        assert.ok(
          region.x >= 0 && region.right <= width - sidebar && region.y >= 0 && region.bottom <= 600,
          `${region.name} must fit ${width}px`,
        );
      for (const button of layout.buttons)
        assert.ok(
          button.text.x >= button.rect.x &&
            button.text.right <= button.rect.right &&
            button.text.y >= button.rect.y &&
            button.text.bottom <= button.rect.bottom,
          `${button.label} must stay inside its clickable button at ${width}px`,
        );
      for (let first = 0; first < layout.regions.length; first++)
        for (let second = first + 1; second < layout.regions.length; second++) {
          const a = layout.regions[first],
            b = layout.regions[second];
          assert.ok(
            a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y,
            `${a.name} must not overlap ${b.name} at ${width}px`,
          );
        }
      if (width === 320) await page.screenshot({ path: `${evidenceDir}/320-task-actions.png` });
      await page.getByRole("button", { name: "停止选中 Agent 及其团队" }).click();
      const icon = page.locator(".bottom-bar-action .icon-button").first();
      await icon.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector(".bottom-bar-action .icon-caption")).opacity ===
          "1",
      );
      const caption = await icon.locator(".icon-caption").boundingBox(),
        anchor = await icon.boundingBox();
      assert.ok(
        caption &&
          anchor &&
          caption.y + caption.height <= anchor.y &&
          caption.x >= 0 &&
          caption.x + caption.width <= width - sidebar,
        "tooltip remains anchored and visible in the canvas area",
      );
      await page.getByRole("button", { name: "更多", exact: true }).click();
      const menu = await page.getByRole("menu", { name: "更多操作" }).boundingBox(),
        toolbar = await page.getByRole("toolbar", { name: "选中操作栏" }).boundingBox();
      assert.ok(
        menu &&
          toolbar &&
          Math.abs(menu.x + menu.width - toolbar.x - toolbar.width) < 2 &&
          menu.y + menu.height <= toolbar.y &&
          menu.x >= 0,
        "more menu remains anchored above the toolbar",
      );
      assert.equal(
        await page.getByRole("menuitem", { name: "复制" }).evaluate((element) => {
          const r = element.getBoundingClientRect();
          return (
            document
              .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
              ?.closest('[role="menuitem"]') === element
          );
        }),
        true,
        "task chips/toast cannot cover the open menu's click target",
      );
      await page.evaluate(() =>
        window.setNoticeLayout({ selected: false, task: false, toast: false, sidebar: 0 }),
      );
      await notice.waitFor({ state: "visible" });
    }
    await page.setViewportSize({ width: 320, height: 600 });
    await page.evaluate(() =>
      window.setNoticeLayout({
        selected: true,
        task: true,
        candidate: true,
        copies: 3,
        pdf: true,
        toast: true,
        sidebar: 280,
        panel: true,
      }),
    );
    await page.locator(".workspace-panel").waitFor({ state: "visible" });
    await page.locator(".bottom-controls").waitFor({ state: "hidden" });
    assert.equal(await page.locator(".task-chip-candidate").count(), 3);
    for (const selector of [".task-bar", ".toast"]) {
      const item = page.locator(selector);
      assert.equal(
        await item.isVisible(),
        true,
        `${selector} remains visible with the narrow sidebar`,
      );
      const rect = await item.boundingBox();
      assert.ok(
        rect &&
          rect.x >= 0 &&
          rect.x + rect.width <= 320 &&
          rect.y >= 0 &&
          rect.y + rect.height <= 600,
        `${selector} uses the full narrow viewport, not the remaining 40px canvas`,
      );
    }
    const accept = page.getByRole("button", { name: "接受全部", exact: true }).first();
    assert.equal(
      await accept.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          document
            .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
            ?.closest("button") === element
        );
      }),
      true,
      "the sidebar must not cover task action hit targets",
    );
    await accept.click();
    assert.deepEqual(await page.evaluate(() => window.taskCalls), ["fixture-task-0"]);
    await page.screenshot({ path: `${evidenceDir}/320-sidebar-task-actions.png` });
    await page.evaluate(() =>
      window.setNoticeLayout((previous) => ({ ...previous, panel: false, sidebar: 0 })),
    );
    await page.locator(".bottom-controls").waitFor({ state: "visible" });
    assert.equal(
      await page.getByRole("button", { name: "交给 Agent 阅读 PDF" }).isVisible(),
      true,
      "closing the sidebar restores the existing selection's PDF action",
    );
    assert.deepEqual(
      await page.evaluate(() => window.updateCalls),
      [],
      "layout deferral must neither dismiss nor install",
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.bottomCalls), ["stop", "stop", "stop"]);
  } finally {
    await browser?.close();
    await server.close();
  }
});
