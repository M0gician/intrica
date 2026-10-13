import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startLocalBackend } from "@intrica/server/runtime";
import { _electron, expect } from "@playwright/test";

import { createDefaultEndpoint } from "../../tests/fixtures/default-endpoint.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
test("real local and remote servers preserve data, tools, drafts, and connection boundaries", {
  timeout: 180000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "intrica-remote-audit-"));
  let remote, app;
  const endpoint = await createDefaultEndpoint();
  t.after(() => endpoint.close());
  const previousModelEnv = Object.fromEntries(
    Object.keys(endpoint.env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, endpoint.env);
  const shutdownErrors = [];
  const report = {
    platform: process.platform,
    executable: process.env.INTRICA_TEST_EXECUTABLE ?? "source",
    checks: [],
  };
  const token = process.env.INTRICA_TEST_REMOTE_TOKEN_FILE
    ? (await readFile(process.env.INTRICA_TEST_REMOTE_TOKEN_FILE, "utf8")).trim()
    : randomUUID();
  if (!process.env.INTRICA_TEST_REMOTE_URL)
    remote = await startLocalBackend({
      userData: join(root, "server"),
      schemaFile: join(directory, "../../db/schema.sql"),
      webRoot: join(directory, "../web/dist"),
      host: "127.0.0.1",
      port: 0,
      accessToken: token,
    });
  for (const [key, value] of Object.entries(previousModelEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const remoteUrl = process.env.INTRICA_TEST_REMOTE_URL ?? remote.apiUrl;
  const launch = async () => {
    const env = { ...process.env, ...endpoint.env, INTRICA_DESKTOP_PORT: "0" };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.INTRICA_SERVER_URL;
    delete env.INTRICA_ACCESS_TOKEN;
    app = await _electron.launch({
      executablePath: process.env.INTRICA_TEST_EXECUTABLE || (await import("electron")).default,
      args: [
        ...(process.env.INTRICA_TEST_EXECUTABLE ? [] : [join(directory, "main.mjs")]),
        `--user-data-dir=${join(root, "client")}`,
      ],
      env,
      timeout: 45000,
    });
    app.context().setDefaultTimeout(20000);
    const stderr = [];
    app.process().stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr.push(text);
      if (/done is not a function|\[worker:restart\]/.test(text)) shutdownErrors.push(text);
    });
    const page = await app.firstWindow();
    try {
      await page.waitForURL("intrica://app/**");
      await page.evaluate(() => localStorage.setItem("intrica:language", "zh-CN"));
      await page.reload();
      await expect(page.getByRole("button", { name: "切换画布", exact: true })).toBeVisible({
        timeout: 30000,
      });
    } catch (error) {
      console.error("[desktop startup]", stderr.join(""));
      throw error;
    }
    return page;
  };
  const call = (page, path, method = "GET", body) =>
    page.evaluate(
      async ({ path, method, body }) => {
        const connection = await window.intricaDesktop.connection.get();
        const response = await fetch(`${connection.apiBase}/api/v2/${path}`, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        });
        if (!response.ok) throw new Error(`API ${path}: ${response.status}`);
        return response.json();
      },
      { path, method, body },
    );
  const create = async (page, prefix) => {
    const canvas = (
      await call(page, "canvases", "POST", {
        title: `${prefix}-${randomUUID()}`,
        idempotencyKey: randomUUID(),
      })
    ).node;
    const agent = (
      await call(page, "nodes", "POST", {
        kind: "agent",
        title: `${prefix} agent`,
        parentId: canvas.id,
        agent: { persona: "A test-only assistant.", role: "read", enabled: false },
        position: { x: 120, y: 100, width: 260, height: 320 },
        idempotencyKey: randomUUID(),
      })
    ).node;
    await page.reload();
    await page.getByRole("button", { name: "切换画布", exact: true }).click();
    await page.getByRole("button", { name: canvas.title, exact: true }).click();
    await page.locator(`[data-node-id="${agent.id}"]`).dblclick();
    return { canvas, agent };
  };
  const settings = async (page) => {
    await expect(page.getByRole("button", { name: /^(切换画布|Switch canvas)$/ })).toBeVisible();
    await page.keyboard.press("Control+,");
    const dialog = page.getByRole("main", { name: "设置", exact: true });
    await dialog.getByRole("button", { name: "服务器连接", exact: true }).click();
    return dialog;
  };
  const quickConnect = async (page, name) => {
    await page.getByRole("button", { name: "切换画布", exact: true }).click();
    await page.getByRole("button", { name: "切换服务器", exact: true }).click();
    const menu = page.getByRole("menu", { name: "切换服务器", exact: true });
    await menu.getByRole("menuitemradio", { name, exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect(page.getByRole("button", { name: "切换画布", exact: true })).toBeVisible();
  };
  const terminal = async (page, canvasId, expectedOS) => {
    const workspace = await call(page, `workspace/root?canvasId=${canvasId}`);
    const session = await call(page, "workspace/terminals", "POST", {
      cwd: workspace.path,
      cols: 80,
      rows: 24,
    });
    try {
      await call(page, `workspace/terminals/${session.id}/input`, "POST", { data: "uname -s\r" });
      const output = await page.evaluate(
        async ({ id, expectedOS }) => {
          const c = await window.intricaDesktop.connection.get(),
            abort = new AbortController();
          const timer = setTimeout(() => abort.abort(), 10000);
          let text = "";
          try {
            const response = await fetch(`${c.apiBase}/api/v2/workspace/terminals/${id}/output`, {
              signal: abort.signal,
            });
            const reader = response.body.getReader(),
              decoder = new TextDecoder();
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              text += decoder.decode(next.value);
              if (text.includes(expectedOS)) break;
            }
            return text;
          } finally {
            abort.abort();
            clearTimeout(timer);
          }
        },
        { id: session.id, expectedOS },
      );
      assert.ok(output.includes(expectedOS));
    } finally {
      await call(page, `workspace/terminals/${session.id}`, "DELETE");
    }
  };
  try {
    let page = await launch();
    const localServer = await call(page, "server");
    const local = await create(page, "local audit");
    await page.getByLabel("Agent 任务").fill("local draft must survive switching");
    await terminal(page, local.canvas.id, process.platform === "darwin" ? "Darwin" : "Linux");
    report.checks.push("local canvas, agent, terminal");
    const dialog = await settings(page);
    await dialog.getByRole("button", { name: "添加服务器", exact: true }).click();
    await dialog.getByRole("button", { name: "手动添加服务器…", exact: true }).click();
    await dialog.getByLabel("连接方式", { exact: true }).selectOption("http");
    await dialog.getByLabel("名称", { exact: true }).fill("Audit remote");
    await dialog
      .getByLabel("服务器地址", { exact: true })
      .fill(remoteUrl.replace(/^http:\/\//, ""));
    await dialog.getByLabel("访问令牌", { exact: true }).fill(token);
    await dialog.getByRole("checkbox", { name: "在此设备安全保存令牌", exact: true }).uncheck();
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.getByRole("button", { name: "返回画布", exact: true }).click();
    await quickConnect(page, "Audit remote");
    const remoteServer = await call(page, "server");
    assert.notEqual(localServer.id, remoteServer.id);
    assert.ok(!(await call(page, "bootstrap")).nodes.some((n) => n.id === local.canvas.id));
    const remoteBoard = await create(page, "remote audit");
    await expect(page.getByLabel("Agent 任务")).toHaveValue("");
    await page.getByLabel("Agent 任务").fill("Respond with a short greeting.");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".agent-event-assistant").first()).toBeVisible({ timeout: 20000 });
    await terminal(
      page,
      remoteBoard.canvas.id,
      process.env.INTRICA_TEST_REMOTE_PLATFORM ??
        (process.platform === "darwin" ? "Darwin" : "Linux"),
    );
    const png = (await readFile(join(directory, "assets/icon.png"))).toString("base64");
    const image = await page.evaluate(async (png) => {
      const c = await window.intricaDesktop.connection.get(),
        form = new FormData();
      form.append(
        "file",
        new Blob([Uint8Array.from(atob(png), (char) => char.charCodeAt(0))], { type: "image/png" }),
        "audit.png",
      );
      const response = await fetch(`${c.apiBase}/api/v2/assets`, { method: "POST", body: form });
      if (!response.ok) throw new Error("Upload failed");
      const asset = await response.json();
      const downloaded = await fetch(`${c.apiBase}/api/v2/assets/${asset.assetId}`);
      return { status: downloaded.status, bytes: (await downloaded.arrayBuffer()).byteLength };
    }, png);
    assert.equal(image.status, 200);
    assert.ok(image.bytes > 100);
    report.checks.push(
      "remote identity isolation, model stream, host terminal, binary upload/download",
    );
    if (remote) {
      const downloadPath = join(root, "download-验收.txt");
      await writeFile(downloadPath, "exact remote file bytes\n");
      const savedPath = join(root, "saved-验收.txt");
      await app.evaluate(({ dialog }, path) => {
        dialog.showSaveDialog = async () => ({ filePath: path, canceled: false });
      }, savedPath);
      await page.evaluate(async (path) => {
        const connection = await window.intricaDesktop.connection.get();
        return window.intricaDesktop.files.save({
          id: crypto.randomUUID(),
          bindingId: connection.bindingId,
          path,
        });
      }, downloadPath);
      assert.equal(await readFile(savedPath, "utf8"), "exact remote file bytes\n");
      report.checks.push(
        "remote workspace file streamed through desktop protocol to local download",
      );
    }
    const active = await page.evaluate(() => window.intricaDesktop.connection.get());
    const refused = await page.evaluate(
      async ({ remoteUrl, profileId }) => {
        try {
          await window.intricaDesktop.connection.save({
            id: profileId,
            label: "Invalid token",
            baseUrl: remoteUrl,
            token: "incorrect",
          });
          return false;
        } catch {
          return true;
        }
      },
      { remoteUrl, profileId: active.profileId },
    );
    assert.equal(refused, true);
    assert.equal(
      (await page.evaluate(() => window.intricaDesktop.connection.get())).bindingId,
      active.bindingId,
    );
    await quickConnect(page, "内置本地服务器");
    await page.locator(`[data-node-id="${local.agent.id}"]`).dblclick();
    await expect(page.getByLabel("Agent 任务")).toHaveValue("local draft must survive switching");
    const oldStatus = await page.evaluate(
      async (base) => (await fetch(`${base}/api/v2/server`)).status,
      active.apiBase,
    );
    assert.equal(oldStatus, 410);
    report.checks.push(
      "quick server switching, failed authentication keeps active target, stale binding rejected, local draft restored",
    );
    await app.close();
    app = undefined;
    page = await launch();
    const profiles = await page.evaluate(() => window.intricaDesktop.connection.list());
    const savedRemote = profiles.find((p) => p.label === "Audit remote");
    assert.ok(savedRemote);
    assert.equal(savedRemote.hasToken, false);
    assert.equal(savedRemote.persistent, false);
    await page.getByRole("button", { name: "切换画布", exact: true }).click();
    await page.getByRole("button", { name: "切换服务器", exact: true }).click();
    const failedSwitch = page.getByRole("menu", { name: "切换服务器", exact: true });
    await failedSwitch.getByRole("menuitemradio", { name: "Audit remote", exact: true }).click();
    await expect(failedSwitch.getByRole("alert")).toContainText("连接失败");
    await expect(
      failedSwitch.getByRole("menuitemradio", { name: "内置本地服务器", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    await failedSwitch.getByRole("menuitem", { name: "管理服务器", exact: true }).click();
    const repair = page.getByRole("main", { name: "设置", exact: true });
    await expect(repair.getByRole("heading", { name: "服务器连接", exact: true })).toBeVisible();
    await repair.getByRole("button", { name: "返回画布", exact: true }).click();
    assert.equal((await page.evaluate(() => window.intricaDesktop.connection.get())).mode, "local");
    assert.ok((await call(page, "bootstrap")).nodes.some((n) => n.id === local.canvas.id));
    report.checks.push("restart retains local data and remote directory");
    await app.close();
    app = undefined;
    assert.deepEqual(
      shutdownErrors,
      [],
      "shutdown must not invoke a second database exit hook or restart workers",
    );
    report.checks.push("clean shutdown without duplicate database hooks or worker restarts");
    report.remotePlatform = process.env.INTRICA_TEST_REMOTE_PLATFORM ?? process.platform;
    report.success = true;
  } finally {
    await app?.close();
    await remote?.close();
    await rm(root, { recursive: true, force: true });
    if (process.env.INTRICA_TEST_REPORT) {
      await mkdir(dirname(process.env.INTRICA_TEST_REPORT), { recursive: true });
      await writeFile(process.env.INTRICA_TEST_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    }
  }
});
