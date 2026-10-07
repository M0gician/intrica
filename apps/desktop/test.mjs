import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { _electron, expect } from "@playwright/test";

const directory = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(directory, "../web/dist");
const version = JSON.parse(await readFile(join(directory, "package.json"), "utf8")).version;
test("native browser supports scripts, forms, navigation and sidebar lifecycle without page privileges", {
  timeout: 60000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "intrica-desktop-test-"));
  let authScriptLoads = 0;
  const fixture = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://fixture").pathname;
    if (pathname === "/login" || pathname === "/logout") {
      response.writeHead(302, {
        "Set-Cookie":
          pathname === "/login"
            ? "fixtureAuth=1; HttpOnly; Path=/; SameSite=Lax"
            : "fixtureAuth=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax",
        Location: pathname === "/login" ? "/account?save=1" : "/account",
      });
      response.end();
      return;
    }
    if (pathname === "/account-cache.js") {
      authScriptLoads++;
      response.writeHead(200, {
        "Content-Type": "text/javascript",
        "Cache-Control": "public, max-age=3600",
      });
      response.end('document.body.style.fontSize = "40px";');
      return;
    }
    if (pathname === "/account") {
      const authenticated = request.headers.cookie?.includes("fixtureAuth=1");
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(`<body style="background:${authenticated ? "lightgreen" : "pink"}"><h1>${authenticated ? "Signed in" : "Signed out"}</h1><a href="/login">Log in</a><a href="/logout">Log out</a><script>
        if (${!!authenticated && request.url.includes("save=1")}) localStorage.setItem("fixtureSession", "shared");
        document.title = ${JSON.stringify(authenticated ? "Signed in" : "Signed out")} + ":" + (localStorage.getItem("fixtureSession") || "empty");
        </script><script src="/account-cache.js"></script></body>`);
      return;
    }
    if (request.url === "/api/v2/server") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          id: "fixture",
          name: "Fixture Server",
          version,
          apiVersion: "v2",
          graphProtocol: 1,
          web: { enabled: true },
        }),
      );
      return;
    }
    if (request.url === "/api/v2/capabilities") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          server: { files: true, terminals: true, assets: true, models: true },
          agent: { enabled: true, canvas: true, browserAutomation: false },
          desktop: { nativeBrowser: false, nativeNotifications: false, filePicker: false },
        }),
      );
      return;
    }
    if (request.url === "/api/v2/session") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ authenticated: true, protected: false }));
      return;
    }
    if (pathname === "/api/v2/bootstrap") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          graphRevision: 1,
          activeCanvasId: "root",
          canvasSeq: "0",
          latestModelBatchAt: null,
          latestModelBatchOperationId: null,
          nodes: [
            {
              id: "root",
              canvasId: "root",
              layoutVersion: 0,
              sortKey: "0",
              contentLoaded: true,
              createdAt: "2026-01-01T00:00:00.000Z",
              kind: "group",
              title: "根",
              parentId: null,
              childOrder: ["account"],
              position: { x: 0, y: 0, width: 0, height: 0 },
              lifecycle: "committed",
              origin: "user",
              revision: 1,
            },
            {
              id: "account",
              canvasId: "root",
              layoutVersion: 0,
              sortKey: "1024",
              contentLoaded: true,
              createdAt: "2026-01-01T00:00:00.000Z",
              kind: "text",
              title: "Account",
              text: `${fixtureOrigin}/account`,
              parentId: "root",
              childOrder: [],
              position: { x: 40, y: 80, width: 320, height: 240 },
              lifecycle: "user",
              origin: "user",
              revision: 1,
            },
          ],
          edges: [],
          operations: [],
          candidateNodes: [],
          candidateContainers: [],
        }),
      );
      return;
    }
    if (pathname === "/" || pathname.startsWith("/assets/")) {
      const asset = pathname === "/" ? "index.html" : pathname.slice(1);
      const path = resolve(webRoot, asset);
      if (path.startsWith(`${webRoot}/`)) {
        readFile(path)
          .then((content) => {
            const type = asset.endsWith(".js")
              ? "text/javascript"
              : asset.endsWith(".css")
                ? "text/css"
                : asset.endsWith(".svg")
                  ? "image/svg+xml"
                  : asset.endsWith(".html")
                    ? "text/html; charset=utf-8"
                    : "application/octet-stream";
            response.setHeader("Content-Type", type);
            response.end(content);
          })
          .catch(() => response.writeHead(404).end());
        return;
      }
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "frame-ancestors 'none'",
    });
    if (pathname === "/slow") {
      response.write("<h1>加载中</h1>");
      setTimeout(() => response.end(), 4000).unref();
      return;
    }
    response.end(
      `<title>真实网页</title><h1>${pathname.startsWith("/search") ? "搜索结果" : "浏览器验证"}</h1><button id="counter" onclick="this.textContent=Number(this.textContent)+1">0</button><form action="/search"><input name="q" aria-label="搜索内容"><button>搜索</button></form><a href="/next">下一页链接</a>`,
    );
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;
  let app;
  try {
    const env = { ...process.env, INTRICA_SERVER_URL: fixtureOrigin, INTRICA_DESKTOP_PORT: "0" };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      timeout: 15000,
      executablePath: process.env.INTRICA_TEST_EXECUTABLE || (await import("electron")).default,
      args: [
        ...(process.env.INTRICA_TEST_EXECUTABLE ? [] : [join(directory, "main.mjs")]),
        `--user-data-dir=${profile}`,
      ],
      env,
    });
    app.context().setDefaultTimeout(12000);
    const ui = await app.firstWindow();
    await ui.waitForURL("intrica://app/**");
    await ui.evaluate(() => localStorage.setItem("intrica:language", "zh-CN"));
    await ui.reload();
    await expect(ui.getByRole("button", { name: "打开侧栏" })).toBeVisible();
    const accountImage = ui.locator(".bookmark-card-preview img");
    await expect(accountImage).toHaveAttribute("alt", "Signed out:empty 的网页快照");
    const signedOutImage = await accountImage.getAttribute("src");
    const preview = await ui.evaluate(
      (url) => window.intricaDesktop.browser.preview(url),
      `${fixtureOrigin}/browser`,
    );
    assert.equal(preview.title, "真实网页");
    assert.ok(preview.dataUrl.startsWith("data:image/jpeg;base64,"));
    const pixels = await app.evaluate(({ nativeImage }, url) => {
      const img = nativeImage.createFromDataURL(url);
      const bytes = img.toBitmap();
      return { size: img.getSize(), variation: new Set(bytes).size };
    }, preview.dataUrl);
    assert.equal(pixels.size.width, 600);
    assert.ok(pixels.variation > 30);
    await ui.getByRole("button", { name: "打开侧栏" }).click();
    await ui.getByRole("button", { name: "浏览器", exact: true }).click();
    await ui.getByLabel("网页地址").fill(`${fixtureOrigin.replace("http://", "")}/browser`);
    const pageCreated = app.context().waitForEvent("page");
    await ui.getByLabel("网页地址").press("Enter");
    const browser = await pageCreated;
    await expect(browser.getByRole("heading", { name: "浏览器验证" })).toBeVisible();
    await browser.locator("#counter").click();
    await expect(browser.locator("#counter")).toHaveText("1");
    assert.deepEqual(
      await browser.evaluate(() => [
        typeof window.require,
        typeof window.intricaDesktop,
        typeof window.process,
      ]),
      ["undefined", "undefined", "undefined"],
    );
    const bounds = () =>
      app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const view = window.contentView.children.find(
          (item) => item.webContents !== window.webContents,
        );
        return view?.getBounds() ?? null;
      });
    const expectedBounds = await ui.locator(".native-browser-host").boundingBox();
    await expect.poll(bounds).not.toBeNull();
    const initialBounds = await bounds();
    for (const key of ["x", "y", "width", "height"])
      assert.ok(Math.abs(initialBounds[key] - expectedBounds[key]) <= 1, key);
    await ui.getByRole("button", { name: "展开阅读宽度" }).click();
    await expect.poll(async () => (await bounds()).width).toBeGreaterThan(initialBounds.width);
    await ui.getByRole("button", { name: "详情", exact: true }).click();
    await expect.poll(bounds).toBeNull();
    await ui.getByRole("button", { name: "浏览器", exact: true }).click();
    await expect.poll(bounds).not.toBeNull();
    await expect(browser.locator("#counter")).toHaveText("1");
    await browser.getByLabel("搜索内容").fill("线索");
    await browser.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(browser.getByRole("heading", { name: "搜索结果" })).toBeVisible();
    await expect(ui.getByLabel("网页地址")).toHaveValue(/\/search\?q=/);
    await ui.getByRole("button", { name: "上一页" }).click();
    await expect(browser.getByRole("heading", { name: "浏览器验证" })).toBeVisible();
    await ui.getByRole("button", { name: "下一页" }).click();
    await expect(browser.getByRole("heading", { name: "搜索结果" })).toBeVisible();
    await ui.getByRole("button", { name: "关闭详情侧栏" }).click();
    await expect.poll(bounds).toBeNull();
    await ui.getByRole("button", { name: "打开侧栏" }).click();
    await expect.poll(bounds).not.toBeNull();
    await ui.getByLabel("网页地址").fill(`${fixtureOrigin}/slow`);
    await ui.getByLabel("网页地址").press("Enter");
    await ui.getByRole("button", { name: "停止加载网页" }).click();
    await expect(ui.getByRole("button", { name: "停止加载网页" })).toHaveCount(0);
    await expect(ui.locator(".workspace-browser .workspace-error")).toHaveCount(0);
    await ui.getByLabel("网页地址").fill("javascript:alert(1)");
    await ui.getByLabel("网页地址").press("Enter");
    await expect(ui.getByRole("alert")).toContainText("HTTP 或 HTTPS");
    await assert.rejects(
      ui.evaluate(() => window.intricaDesktop.browser.command("navigate", "file:///etc/passwd")),
    );
    await ui.getByLabel("网页地址").fill(`${fixtureOrigin}/account`);
    await ui.getByLabel("网页地址").press("Enter");
    await expect(browser).toHaveTitle("Signed out:empty");
    await browser.getByRole("link", { name: "Log in", exact: true }).click();
    await expect(browser).toHaveTitle("Signed in:shared");
    await expect(accountImage).toHaveAttribute("alt", "Signed in:shared 的网页快照");
    assert.notEqual(await accountImage.getAttribute("src"), signedOutImage);
    const signedIn = await ui.evaluate(
      (url) => window.intricaDesktop.browser.preview(url),
      `${fixtureOrigin}/account`,
    );
    assert.equal(signedIn.title, "Signed in:shared");
    assert.notEqual(signedIn.dataUrl, signedOutImage);
    assert.equal(authScriptLoads, 1, "sidebar and snapshot reuse the same HTTP cache");
    assert.deepEqual(
      await app.evaluate(async ({ session }, url) => {
        const web = await session.fromPartition("persist:intrica-browser").cookies.get({ url });
        const main = await session.fromPartition("persist:intrica-app").cookies.get({ url });
        return {
          web: web.some((cookie) => cookie.name === "fixtureAuth" && cookie.httpOnly),
          main: main.length,
        };
      }, fixtureOrigin),
      { web: true, main: 0 },
    );
    await browser.getByRole("link", { name: "Log out", exact: true }).click();
    await expect(browser).toHaveTitle("Signed out:shared");
    await expect(accountImage).toHaveAttribute("alt", "Signed out:shared 的网页快照");
    const signedOut = await ui.evaluate(
      (url) => window.intricaDesktop.browser.preview(url),
      `${fixtureOrigin}/account`,
    );
    assert.equal(signedOut.title, "Signed out:shared");
    assert.notEqual(signedOut.dataUrl, signedIn.dataUrl);
    // SPA login can change cookies without navigating the visible browser page.
    // Playwright dispatches mouse events to renderers without changing native focus.
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().startsWith("intrica:"),
      );
      window.focus();
      window.contentView.children
        .find((v) => v.webContents !== window.webContents)
        .webContents.focus();
    });
    await browser.evaluate(() => fetch("/login"));
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().startsWith("intrica:"))
        .webContents.focus();
    });
    await ui.getByLabel("网页地址").click();
    await expect(accountImage).toHaveAttribute("alt", "Signed in:shared 的网页快照");
    if (process.env.INTRICA_TEST_PUBLIC_BROWSER === "1") {
      await ui.getByLabel("网页地址").fill("https://www.google.com/");
      await ui.getByLabel("网页地址").press("Enter");
      await expect(browser).toHaveTitle(/Google/, { timeout: 20000 });
      await expect(browser.getByRole("combobox")).toBeVisible({ timeout: 20000 });
      await browser.getByRole("combobox").fill("Intrica browser verification");
      await expect(browser.getByRole("combobox")).toHaveValue("Intrica browser verification");
      await browser.getByRole("combobox").fill("");
      await expect(ui.locator(".workspace-browser .workspace-error")).toHaveCount(0);
    }
    const output = join(directory, "test-results");
    await mkdir(output, { recursive: true });
    await browser.screenshot({ path: join(output, "native-page.png") });
    await ui.screenshot({ path: join(output, "browser-controls.png") });
  } finally {
    await app?.close();
    await new Promise((resolve) => fixture.close(resolve));
    await rm(profile, { recursive: true, force: true });
  }
});
