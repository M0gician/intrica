import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
import {ConnectionServices,createSessionConnection} from "/src/api/connection.ts";
import {TimelineEvent} from "/src/features/conversations/TimelineEvent.tsx";
import {useModalCount} from "/src/ui/modal-state.ts";
import "/src/styles.css";
const h=React.createElement;
function Fixture() {
  // App observes modal state to suspend the native browser. This render must
  // not replace Markdown's stateful links and close the newly opened dialog.
  const modals=useModalCount();
  const [state,setState]=React.useState({server:"one",agent:"author",text:""});
  const connection=React.useMemo(()=>createSessionConnection("",state.server),[state.server]);
  React.useEffect(()=>()=>connection.dispose(),[connection]);
  window.showMessage=(patch)=>setState((current)=>({...current,...patch}));
  return h(ConnectionServices.Provider,{value:connection},
    h("main",{style:{padding:32}},h("output",{"aria-label":"Open dialogs"},modals),
      h(TimelineEvent,{event:{seq:1,kind:"assistant",agentId:state.agent,data:{text:state.text}},nodes:new Map(),requestEvent:new Map()})));
}
createRoot(document.getElementById("root")).render(h(Fixture));
</script></body></html>`;
const cases = [
  {
    name: "motion.gif",
    mime: "image/gif",
    data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  },
  {
    name: "diagram.png",
    mime: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQMgkTMgljgFAAEA4CcV2GZ44AAAAASUVORK5CYII=",
  },
  { name: "analysis.py", mime: "text/plain", text: "print('Example')\n" },
  { name: "data.json", mime: "application/json", text: '{"count": 3}\n' },
  { name: "bundle.bin", mime: "application/octet-stream", previewError: "unsupported" },
];

test("Markdown file links retain previews across modal and message updates", {
  timeout: 60000,
}, async () => {
  const requests = [];
  let source = cases[0];
  let denied = false;
  const bytes = () =>
    source.data ? Buffer.from(source.data, "base64") : Buffer.from(source.text ?? "binary file");
  const server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "file-reference-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            const url = new URL(req.url, "http://fixture");
            if (url.pathname.startsWith("/api/v2/files/")) {
              const reference = JSON.parse(
                Buffer.from(url.searchParams.get("reference"), "base64url"),
              );
              requests.push({ route: url.pathname, reference });
              if (denied) {
                res.writeHead(403, { "content-type": "application/json" });
                res.end(
                  JSON.stringify({ error: { code: "FORBIDDEN", message: "File access denied" } }),
                );
              } else if (url.pathname.endsWith("/download")) {
                res.writeHead(200, {
                  "content-type": "application/octet-stream",
                  "content-disposition": `attachment; filename="${source.name}"`,
                  "content-length": bytes().length,
                });
                res.end(req.method === "HEAD" ? undefined : bytes());
              } else {
                res.setHeader("content-type", "application/json");
                res.end(
                  JSON.stringify({
                    ...source,
                    path: `/output/${source.name}`,
                    serverId: reference.serverId,
                  }),
                );
              }
              return;
            }
            if (req.url !== "/__file-links") return next();
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
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("intrica:language", "en"));
    await page.goto(`${server.resolvedUrls.local[0]}__file-links`);
    await page.waitForFunction(() => Boolean(window.showMessage));
    for (const file of cases) {
      source = file;
      const text = `[Open ${file.name}](intrica-file:artifact-${file.name})`;
      await page.evaluate((text) => window.showMessage({ text }), text);
      const trigger = page.getByRole("button", { name: `Open ${file.name}`, exact: true });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: file.name, exact: true });
      await expect(dialog).toBeVisible({ timeout: 3000 });
      const requestCount = requests.length;
      // Streaming text and refreshed source objects must preserve this dialog.
      await page.evaluate(
        (text) => window.showMessage({ text: `${text}\n\nMore progress.` }),
        text,
      );
      await expect(dialog).toBeVisible();
      await expect(page.getByLabel("Open dialogs")).toHaveText("1");
      assert.equal(requests.length, requestCount, "parent renders must not restart previews");
      if (file.data) {
        await expect(dialog.getByRole("img", { name: file.name })).toBeVisible();
        await expect
          .poll(() => dialog.locator("img").evaluate((img) => img.naturalWidth))
          .toBeGreaterThan(0);
      } else if (file.text) {
        await expect(dialog.locator(".cm-content")).toContainText(file.text.trim());
      } else {
        await expect(
          dialog.getByRole("status").filter({ hasText: "No preview is available" }),
        ).toBeVisible();
      }
      const download = page.waitForEvent("download");
      await dialog.getByRole("button", { name: "Download to this device", exact: true }).click();
      const saved = await download;
      assert.equal(saved.suggestedFilename(), file.name);
      assert.equal(await saved.failure(), null);
      assert.deepEqual(await readFile(await saved.path()), bytes());
      await saved.delete();
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByLabel("Open dialogs")).toHaveText("0");
      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    assert.ok(
      requests.every(
        ({ reference }) =>
          reference.serverId === "one" &&
          reference.origin.kind === "agent" &&
          reference.origin.id === "author",
      ),
    );
    denied = true;
    await page.getByRole("button", { name: "Open bundle.bin", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toHaveText(
      "This action is not authorized.",
    );
    // A different source or connection must close the old preview.
    await page.evaluate(() => window.showMessage({ agent: "another-author", server: "two" }));
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Open bundle.bin", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
    assert.equal(requests.at(-1).reference.serverId, "two");
    assert.equal(requests.at(-1).reference.origin.id, "another-author");
    await page.keyboard.press("Escape");
    denied = false;
    source = cases[1];
    const imageText =
      "![Inline diagram](intrica-file:diagram)\n\n[Website](https://example.com/docs)";
    await page.evaluate((text) => window.showMessage({ text }), imageText);
    await expect(page.getByRole("img", { name: "Inline diagram" })).toBeVisible();
    const inlineRequests = requests.length;
    await page.getByRole("button", { name: "Inline diagram" }).click();
    await expect(page.getByRole("dialog", { name: source.name })).toBeVisible();
    await page.evaluate((text) => window.showMessage({ text: `${text}\n\nUpdated.` }), imageText);
    await expect(page.getByRole("dialog", { name: source.name })).toBeVisible();
    assert.equal(requests.length, inlineRequests + 1, "image previews must survive parent updates");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("link", { name: "Website" })).toHaveAttribute(
      "href",
      "https://example.com/docs",
    );
    await expect(page.getByRole("link", { name: "Website" })).toHaveAttribute("target", "_blank");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
