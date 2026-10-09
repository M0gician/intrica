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
function Fixture() {
  const [texts,setTexts]=React.useState({workspace:"A short message.",agent:"Another message"});
  window.setReceiptExamples=setTexts;
  return h("main",{style:{width:540,padding:30}},
    h("input",{id:"before","aria-label":"Focus before messages"}),
    h("section",{className:"agent-transcript",style:{padding:0,height:"auto"}},
      h("article",{id:"workspace",className:"chat-user"},
        h(MarkdownLite,{text:texts.workspace}),
        h(InputReceipt,{conversationId:"conversation",receipt:texts.receiptState===null?undefined:{messageId:"workspace-input",state:texts.receiptState??"unread"}}))),
    h("section",{className:"agent-activity"},
      h("article",{id:"agent",className:"agent-event agent-event-user"},
        h(TimelineEvent,{event:{id:"agent-input",kind:"user",agentId:"agent",conversationId:"conversation",createdAt:"2026-10-01T01:02:03Z",data:{text:texts.agent,inputReceipt:texts.receiptState===null?undefined:{messageId:"agent-input",state:texts.receiptState??"unread"}}},nodes:new Map(),requestEvent:new Map()}))));
}
createRoot(document.getElementById("root")).render(h(Fixture));
</script></body></html>`;

async function assertTimestampFits(bubble) {
  const frame = await bubble.boundingBox();
  const body = await bubble.locator(".markdown-lite").boundingBox();
  const timestamp = await bubble.locator("time").boundingBox();
  assert.ok(timestamp.height <= 14, "the timestamp must stay on one line");
  assert.ok(
    timestamp.x >= body.x + 8,
    "the timestamp must be inset to the right of the message text",
  );
  assert.ok(
    timestamp.x >= frame.x + 4 &&
      timestamp.x + timestamp.width <= frame.x + frame.width - 4 &&
      timestamp.y >= body.y + body.height + 2 &&
      timestamp.y + timestamp.height <= frame.y + frame.height - 4,
    "the entire timestamp must fit inside the bubble below the message",
  );
  return timestamp;
}

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
    const page = await browser.newPage({
      viewport: { width: 700, height: 700 },
      timezoneId: "Asia/Singapore",
    });
    await page.addInitScript(() => localStorage.setItem("intrica:language", "en"));
    const sent = [];
    await page.route("**/api/v2/conversations/conversation/expedite", async (route) => {
      sent.push(route.request().postDataJSON());
      if (sent.length === 1) {
        await route.fulfill({
          status: 503,
          json: { error: { code: "INTERNAL", message: "Could not expedite this input." } },
        });
        return;
      }
      await route.fulfill({ json: { state: "read" } });
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__receipts`);
    await expect(page.locator(".input-expedite")).toHaveCount(2);
    for (const width of [300, 540]) {
      await page.locator("main").evaluate((element, width) => {
        element.style.width = `${width}px`;
      }, width);
      for (const text of [
        "好",
        "x",
        "👍",
        "A short message.",
        "First line: Unicode and spaces.\nSecond line: a file without an extension.\n" +
          "UnbrokenFileName".repeat(8),
        "检查资料并保留结果。\n名称包含中文、空格和 Unicode λ。\n" +
          "需要逐项核对的内容。".repeat(6),
      ]) {
        await page.evaluate(
          (text) => window.setReceiptExamples({ workspace: text, agent: text }),
          text,
        );
        await expect(page.locator("#workspace .markdown-lite")).toHaveText(text);
        for (const id of ["workspace", "agent"]) {
          const bubble = page.locator(`#${id}`),
            button = bubble.getByRole("button", { name: "Expedite", exact: true }),
            status = bubble.getByRole("status");
          const before = await bubble.boundingBox();
          const parent = await bubble.locator("..").boundingBox();
          assert.ok(Math.abs(before.x + before.width - parent.x - parent.width) < 1);
          const appearance = await bubble.evaluate((element) => {
            const style = getComputedStyle(element);
            return [style.backgroundColor, style.borderRadius];
          });
          assert.deepEqual(appearance, ["rgb(241, 240, 237)", "18px"]);
          const body = await bubble.locator(".markdown-lite").boundingBox();
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
          assert.ok(
            body.y + body.height <= icon.y - 2,
            "receipts must not cover the last text line",
          );
          await expect(button.locator("svg")).toHaveAttribute("fill", "none");
          await expect(button.locator("svg")).toHaveAttribute("stroke", "currentColor");
          assert.ok(overlay.width <= 24);
          assert.ok(overlay.height <= 24);
          assert.ok(
            icon.y + icon.height <= before.y + before.height &&
              icon.y > before.y + before.height - 32,
          );
          const time = bubble.locator("time");
          if (id === "agent") {
            const timestamp = await assertTimestampFits(bubble);
            assert.ok(icon.x >= timestamp.x + timestamp.width);
            assert.ok(icon.x - timestamp.x - timestamp.width < 9);
          } else await expect(time).toHaveCount(0);
          await page.mouse.move(650, 650);
          await expect(button).toHaveCSS("opacity", "0");
        }
      }
    }
    await page.evaluate(() =>
      window.setReceiptExamples({
        workspace: "这是已提交的输入。\n每条记录保留原始顺序。\n等待处理结果。",
        agent:
          "这是一条等待进入上下文的多行输入。窗口变窄时，正文应自然换行，右下角的状态图标保持固定，正文不会被图标遮挡。",
      }),
    );
    await page.locator("#before").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#workspace .input-expedite")).toBeFocused();
    await expect(page.locator("#workspace .input-expedite")).toHaveCSS("opacity", "1");
    await page.keyboard.press("Enter");
    const error = page.locator("#workspace").getByRole("alert");
    await expect(error).toBeVisible();
    const errorBox = await error.boundingBox();
    const footer = await page.locator("#workspace .input-receipt").boundingBox();
    assert.ok(errorBox.y + errorBox.height <= footer.y - 2, "errors must not cover the receipt");
    await page.locator("#workspace .input-expedite").press("Enter");
    await expect(
      page.locator("#workspace").getByRole("status", { name: "Read", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#workspace .input-expedite")).toHaveCount(0);
    await expect(error).toHaveCount(0);
    assert.deepEqual(sent, [{ messageId: "workspace-input" }, { messageId: "workspace-input" }]);
    await page.locator("#agent").hover();
    await expect(page.locator("#agent time")).toHaveCSS("opacity", "1");
    await page.locator("#before").evaluate((element) => {
      element.style.visibility = "hidden";
    });
    await page.locator("main").screenshot({ path: "/tmp/intrica-receipt-layout.png" });
    await page.locator("main").evaluate((element) => {
      element.style.width = "300px";
    });
    for (const language of ["en", "zh-CN"]) {
      await page.evaluate(async (language) => {
        const { setLanguage } = await import("/src/i18n/index.ts");
        await setLanguage(language);
      }, language);
      for (const receiptState of [null, "read"]) {
        await page.evaluate(
          (receiptState) =>
            window.setReceiptExamples({ workspace: "好", agent: "好", receiptState }),
          receiptState,
        );
        await expect(page.locator("#agent .markdown-lite")).toHaveText("好");
        await expect(page.locator("#agent").getByRole("status")).toHaveCount(receiptState ? 1 : 0);
        await assertTimestampFits(page.locator("#agent"));
      }
      await page.locator("#agent").hover();
      await page.locator("main").screenshot({ path: `/tmp/intrica-bubble-width-${language}.png` });
    }
  } finally {
    await browser?.close();
    await server.close();
  }
});
