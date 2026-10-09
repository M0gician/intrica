import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../../apps/web", import.meta.url));
const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div>
<script type="module">
import React from "react";
import {createRoot} from "react-dom/client";
import {InputReceipt} from "/src/features/conversations/InputReceipt.tsx";
import {TimelineEvent} from "/src/features/conversations/TimelineEvent.tsx";
import {MarkdownLite} from "/src/components/MarkdownLite.tsx";
import "/src/styles.css";
const h=React.createElement;
createRoot(document.getElementById("root")).render(h("main",{style:{width:360,padding:30}},
  h("input",{id:"before","aria-label":"Focus before messages"}),
  h("article",{id:"workspace",className:"chat-user"},
    h(MarkdownLite,{text:"A message with several words and Unicode: λ. More words wrap across lines."}),
    h(InputReceipt,{conversationId:"conversation",receipt:{messageId:"workspace-input",state:"unread"}})),
  h("article",{id:"agent",className:"agent-event agent-event-user"},
    h(TimelineEvent,{event:{id:"agent-input",kind:"user",agentId:"agent",conversationId:"conversation",createdAt:"2026-10-01T01:02:03Z",data:{text:"Another message\\n\\nWith two paragraphs.",inputReceipt:{messageId:"agent-input",state:"unread"}}},nodes:new Map(),requestEvent:new Map()}))));
</script></body></html>`;

test("both message bubbles use an icon footer and a hover-only overlay without layout movement", async () => {
  const server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "receipt-layout-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (req.url !== "/__receipts") return next();
            res.setHeader("content-type", "text/html");
            res.end(await vite.transformIndexHtml(req.url, html));
          });
        },
      },
    ],
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 700, height: 700 } });
    await page.addInitScript(() => localStorage.setItem("intrica:language", "en"));
    const sent = [];
    await page.route("**/api/v2/conversations/conversation/expedite", async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({ json: { state: "read" } });
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__receipts`);
    await expect(page.locator(".input-expedite")).toHaveCount(2);
    for (const id of ["workspace", "agent"]) {
      const bubble = page.locator(`#${id}`),
        button = bubble.getByRole("button", { name: "Expedite", exact: true }),
        status = bubble.getByRole("status");
      const before = await bubble.boundingBox();
      await expect(button).toHaveCSS("opacity", "0");
      assert.equal(await status.textContent(), "");
      assert.equal(await button.textContent(), "");
      await bubble.hover();
      await expect(button).toHaveCSS("opacity", "1");
      assert.deepEqual(await bubble.boundingBox(), before);
      const overlay = await button.boundingBox(),
        icon = await status.boundingBox();
      assert.ok(overlay.x < before.x + 5 && overlay.y < before.y + 5);
      const rightGap = before.x + before.width - icon.x - icon.width;
      const bottomGap = before.y + before.height - icon.y - icon.height;
      assert.ok(rightGap >= 4 && rightGap <= 10);
      assert.ok(bottomGap >= 4 && bottomGap <= 10);
      assert.ok(icon.width <= 14);
      assert.ok(overlay.width <= 24);
      assert.ok(overlay.height <= 24);
      assert.ok(
        icon.y + icon.height <= before.y + before.height && icon.y > before.y + before.height - 32,
      );
      const time = bubble.locator("time");
      if (id === "agent") {
        const timestamp = await time.boundingBox();
        assert.ok(icon.x >= timestamp.x + timestamp.width);
        assert.ok(icon.x - timestamp.x - timestamp.width < 9);
      } else await expect(time).toHaveCount(0);
      await page.mouse.move(650, 650);
      await expect(button).toHaveCSS("opacity", "0");
    }
    await page.locator("#before").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#workspace .input-expedite")).toBeFocused();
    await expect(page.locator("#workspace .input-expedite")).toHaveCSS("opacity", "1");
    await page.keyboard.press("Enter");
    await expect(
      page.locator("#workspace").getByRole("status", { name: "Read", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#workspace .input-expedite")).toHaveCount(0);
    assert.deepEqual(sent, [{ messageId: "workspace-input" }]);
    await page.locator("#agent").hover();
    await expect(page.locator("#agent time")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: "/tmp/intrica-receipt-layout.png" });
  } finally {
    await browser?.close();
    await server.close();
  }
});
