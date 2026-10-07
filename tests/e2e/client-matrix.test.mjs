import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { _electron, chromium, expect } from "@playwright/test";
import {
  prepareJourney,
  seedPendingApproval,
  verifyJourney,
  verifyPendingApproval,
} from "../fixtures/agent-journey.mjs";
import {
  createMatrixServer,
  matrixClient,
  seedMatrixBoard,
  verifyMatrixContent,
  verifyMatrixMedia,
  verifyMatrixTerminal,
} from "../fixtures/client-matrix.mjs";
import { verifyMatrixPdf } from "../fixtures/client-matrix-pdf.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const requireDesktop = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const modes = process.env.INTRICA_MATRIX_MODES?.split(",") ?? ["web", "desktop"];
assert.ok(
  modes.every((mode) => ["web", "desktop"].includes(mode)),
  "Unknown matrix mode",
);
process.env.MODEL_KIND = "mock";

async function ready(page, server) {
  await expect(
    page
      .getByLabel("访问令牌", { exact: true })
      .or(page.getByRole("button", { name: "切换画布", exact: true })),
  ).toBeVisible();
  if (await page.getByLabel("访问令牌", { exact: true }).isVisible()) {
    await page.getByLabel("访问令牌", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "连接", exact: true }).click();
  }
  await expect(page.getByRole("button", { name: "切换画布", exact: true })).toBeVisible();
}

async function openBoard(page, saved) {
  await page.getByRole("button", { name: "切换画布", exact: true }).click();
  await page.getByRole("button", { name: saved.board.title, exact: true }).click();
  await page.locator(`[data-node-id="${saved.agent.id}"]`).dblclick();
}

async function addServer(page, mode, server) {
  await expect(page.getByRole("button", { name: /^(切换画布|Switch canvas)$/ })).toBeVisible();
  await page.keyboard.press("Control+,");
  const dialog = page.getByRole("main", { name: "设置", exact: true });
  await dialog.getByRole("button", { name: "服务器连接", exact: true }).click();
  await dialog.getByRole("button", { name: "添加服务器", exact: true }).click();
  if (mode === "desktop") {
    await dialog.getByRole("button", { name: "手动添加服务器…", exact: true }).click();
    await dialog.getByLabel("连接方式", { exact: true }).selectOption("http");
  }
  await dialog.getByLabel("名称", { exact: true }).fill(`Matrix ${server.label}`);
  await dialog.getByLabel("服务器地址", { exact: true }).fill(server.baseUrl);
  if (mode === "desktop") {
    await dialog.getByLabel("访问令牌", { exact: true }).fill(server.token);
    await dialog.getByRole("checkbox", { name: "在此设备安全保存令牌", exact: true }).uncheck();
  }
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.getByRole("button", { name: "返回画布", exact: true }).click();
}

async function switchServer(page, server) {
  await page.getByRole("button", { name: "切换画布", exact: true }).click();
  await page.getByRole("button", { name: "切换服务器", exact: true }).click();
  await page
    .getByRole("menu", { name: "切换服务器", exact: true })
    .getByRole("menuitemradio", { name: `Matrix ${server.label}`, exact: true })
    .click();
  await ready(page, server);
}

for (const mode of modes) {
  test(`client matrix: ${mode} local / single server / two servers share the evidence contract`, {
    timeout: 240000,
  }, async () => {
    const profile = await mkdtemp(join(tmpdir(), `intrica-matrix-${mode}-`));
    const report = {
      mode,
      platform: process.platform,
      executable: process.env.INTRICA_TEST_EXECUTABLE ?? "source",
      pdfEnabled: process.env.INTRICA_MATRIX_PDF !== "0",
      checks: [],
      success: false,
    };
    const servers = [];
    let browser;
    let app;
    let journey;
    let page;
    try {
      servers.push(await createMatrixServer("A"));
      servers.push(await createMatrixServer("B"));
      const [a, b] = servers;
      const identities = await Promise.all(servers.map((server) => server.call("server")));
      assert.notEqual(identities[0].id, identities[1].id);
      if (mode === "web") {
        browser = await chromium.launch();
        const context = await browser.newContext({ locale: "zh-CN" });
        await context.addInitScript(() => localStorage.setItem("intrica:language", "zh-CN"));
        page = await context.newPage();
        await page.goto(a.baseUrl);
        await page.getByLabel("访问令牌", { exact: true }).waitFor();
        await ready(page, a);
      } else {
        const env = { ...process.env, MODEL_KIND: "mock", INTRICA_DESKTOP_PORT: "0" };
        for (const key of [
          "ELECTRON_RUN_AS_NODE",
          "INTRICA_SERVER_URL",
          "INTRICA_ACCESS_TOKEN",
          "DATABASE_URL",
          "PORT",
        ])
          delete env[key];
        app = await _electron.launch({
          executablePath: process.env.INTRICA_TEST_EXECUTABLE || requireDesktop("electron"),
          args: [
            ...(process.env.INTRICA_TEST_EXECUTABLE ? [] : [join(root, "apps/desktop/main.mjs")]),
            `--user-data-dir=${profile}`,
          ],
          env,
          timeout: 45000,
        });
        page = await app.firstWindow();
        await page.waitForURL("intrica://app/**");
        await page.evaluate(() => localStorage.setItem("intrica:language", "zh-CN"));
        await page.reload();
        await ready(page);
      }
      page.setDefaultTimeout(20000);
      const call = matrixClient(page);
      const checkFileLocations = async (board) => {
        const home = await call("workspace/files?path=~");
        const workspace = await call(`workspace/root?canvasId=${board.id}`);
        // The fixture creates its canvas through the API, outside this page's state.
        await page.reload();
        await page.getByRole("button", { name: "切换画布", exact: true }).click();
        await page.getByRole("button", { name: board.title, exact: true }).click();
        const sidebar = page.locator(".workspace-panel");
        if (!(await sidebar.isVisible()))
          await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
        await sidebar.getByRole("button", { name: "文件", exact: true }).click();
        const files = sidebar.locator(".files-panel");
        await expect(files.locator("button.file-location")).toHaveAttribute("title", home.path);
        await files.getByRole("button", { name: "查看文件位置", exact: true }).click();
        let locations = page.getByRole("dialog", { name: "文件位置", exact: true });
        await expect(locations.getByText(workspace.path, { exact: true })).toBeVisible();
        await locations.getByRole("button", { name: "画布工作目录", exact: true }).click();
        await expect(locations).toHaveCount(0);
        await expect(files.locator("button.file-location")).toHaveAttribute(
          "title",
          workspace.path,
        );
        await files.getByRole("button", { name: "查看文件位置", exact: true }).click();
        locations = page.getByRole("dialog", { name: "文件位置", exact: true });
        await locations.getByRole("button", { name: "用户主目录", exact: true }).click();
        await expect(locations).toHaveCount(0);
        await expect(files.locator("button.file-location")).toHaveAttribute("title", home.path);
      };
      const checkJourney = async (label) => {
        journey = await prepareJourney(call);
        await journey.start();
        await verifyJourney(call, journey);
        await verifyMatrixMedia(page, label);
        await verifyMatrixTerminal(page, journey.board.id);
        await checkFileLocations(journey.board);
        if (process.env.INTRICA_MATRIX_PDF !== "0")
          await verifyMatrixPdf(page, call, journey.board, expect, label);
        report.checks.push(
          `${label}: nested resources, 3 Agents, ordinary messages, real artifacts, paginated evidence, exact media bytes, active-server terminal`,
          `${label}: file browser defaults to the server account home, reveals the canvas shared directory, and navigates both shortcuts through real file APIs`,
        );
        if (process.env.INTRICA_MATRIX_PDF !== "0")
          report.checks.push(
            `${label}: PDF exact bytes, two-page text/image API, real preview pagination, Agent receives text and both page images`,
          );
        await journey.close();
        journey = undefined;
      };
      if (mode === "desktop") {
        await checkJourney("desktop built-in local");
        await addServer(page, mode, a);
        await switchServer(page, a);
      }
      await checkJourney(`${mode} server A`);
      const savedA = await seedMatrixBoard(call, "A");
      await page.reload();
      await ready(page, a);
      await openBoard(page, savedA);
      await page.getByLabel("Agent 任务").fill("DRAFT_A_MUST_NOT_CROSS_SERVERS");
      await addServer(page, mode, b);

      const controlGate = a.hold(`nodes/${savedA.resource.id}/content`);
      const delayedControl = call(`nodes/${savedA.resource.id}/content`);
      await controlGate.waiting;
      controlGate.release();
      assert.equal(
        (await delayedControl).node.text,
        savedA.marker,
        "An unchanged client must receive the real delayed response; the proxy must not manufacture cancellation",
      );
      const gate = a.hold(`nodes/${savedA.resource.id}/content`);
      await page.evaluate(async (id) => {
        const base = window.intricaDesktop
          ? (await window.intricaDesktop.connection.get()).apiBase
          : "";
        window.__matrixOldBase = base;
        window.__matrixLateResult = "pending";
        void fetch(`${base}/api/v2/nodes/${id}/content`)
          .then(async (response) => {
            window.__matrixLateResult = { status: response.status, body: await response.text() };
          })
          .catch(() => {
            window.__matrixLateResult = "aborted";
          });
      }, savedA.resource.id);
      await gate.waiting;
      await switchServer(page, b);
      gate.release();
      if (mode === "desktop") {
        await expect.poll(() => page.evaluate(() => window.__matrixLateResult)).not.toBe("pending");
        const late = await page.evaluate(() => window.__matrixLateResult);
        assert.ok(
          late === "aborted" || late.status === 502,
          "A switched binding must abort its in-flight read",
        );
        assert.equal(
          await page.evaluate(
            async () => (await fetch(`${window.__matrixOldBase}/api/v2/server`)).status,
          ),
          410,
        );
        report.checks.push(
          "desktop cancels in-flight binding and rejects subsequent stale requests with 410",
        );
      } else {
        assert.equal(
          await page.evaluate(() => window.__matrixLateResult),
          undefined,
          "Web switching replaces the old document and its pending work",
        );
        report.checks.push(
          "web uses real origin navigation and independently scoped authentication cookies on the same hostname",
        );
      }
      await checkJourney(`${mode} server B`);
      const savedB = await seedMatrixBoard(call, "B");
      assert.equal(
        savedA.board.id,
        savedB.board.id,
        "This must exercise a real cross-server ID collision",
      );
      await page.reload();
      await ready(page, b);
      await openBoard(page, savedB);
      await expect(page.getByLabel("Agent 任务")).toHaveValue("");
      await page.getByLabel("Agent 任务").fill("DRAFT_B_MUST_NOT_OVERWRITE_A");
      await verifyMatrixContent(page, savedB, identities[1].id);
      await expect(page.locator(`[data-node-id="${savedB.resource.id}"]`)).toContainText(
        savedB.marker,
      );
      await expect(page.locator("body")).not.toContainText(savedA.marker);
      assert.equal((await a.call(`nodes/${savedA.resource.id}/content`)).node.text, savedA.marker);
      assert.ok(
        !JSON.stringify(await call(`bootstrap?canvasId=${savedB.board.id}`)).includes(
          savedA.marker,
        ),
      );
      report.checks.push(
        "distinct server identities, colliding canvas IDs, isolated resources/drafts, delayed old-server read cannot populate the new canvas",
      );

      if (mode === "web") await addServer(page, mode, a);
      const mutationGate = b.hold(`canvases/${savedB.board.id}`);
      await page.evaluate(async (board) => {
        const base = window.intricaDesktop
          ? (await window.intricaDesktop.connection.get()).apiBase
          : "";
        window.__matrixLateMutation = "pending";
        void fetch(`${base}/api/v2/canvases/${board.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "LATE_B_WRITE",
            expectedTitle: board.title,
            idempotencyKey: crypto.randomUUID(),
          }),
        })
          .then((response) => {
            window.__matrixLateMutation = response.status;
          })
          .catch(() => {
            window.__matrixLateMutation = "aborted";
          });
      }, savedB.board);
      await mutationGate.waiting;
      await switchServer(page, a);
      mutationGate.release();
      if (mode === "desktop") {
        await expect
          .poll(() => page.evaluate(() => window.__matrixLateMutation))
          .not.toBe("pending");
        assert.ok(
          ["aborted", 502].includes(await page.evaluate(() => window.__matrixLateMutation)),
        );
      }
      const boardAAfter = (await a.call("bootstrap")).nodes.find(
        (entry) => entry.id === savedA.board.id,
      );
      const boardBAfter = (await b.call("bootstrap")).nodes.find(
        (entry) => entry.id === savedB.board.id,
      );
      assert.equal(
        boardAAfter.title,
        savedA.board.title,
        "A pending mutation must never move to the newly active same-ID canvas",
      );
      assert.equal(
        boardBAfter.title,
        savedB.board.title,
        "The held mutation was cancelled before forwarding",
      );
      report.checks.push(
        "switching during a held mutation cannot send it to the other server's colliding canvas ID",
      );
      await page.locator(`[data-node-id="${savedA.agent.id}"]`).dblclick();
      await expect(page.getByLabel("Agent 任务")).toHaveValue("DRAFT_A_MUST_NOT_CROSS_SERVERS");
      await verifyMatrixContent(page, savedA, identities[0].id);

      journey = await prepareJourney(call);
      const pending = await seedPendingApproval(call, journey);
      a.setOnline(false);
      const offline = await page.evaluate(async () => {
        const base = window.intricaDesktop
          ? (await window.intricaDesktop.connection.get()).apiBase
          : "";
        return (await fetch(`${base}/api/v2/bootstrap`)).status;
      });
      assert.equal(offline, 503);
      assert.equal((await b.call("server")).id, identities[1].id);
      await page.reload();
      await expect(page.getByRole("heading", { name: "连接不可用", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "重新连接", exact: true })).toBeVisible();
      await a.restart();
      a.setOnline(true);
      assert.equal((await a.call("server")).id, identities[0].id);
      await page.getByRole("button", { name: "重新连接", exact: true }).click();
      await ready(page, a);
      await verifyMatrixContent(page, savedA, identities[0].id);
      await verifyPendingApproval(call, journey, pending);
      report.checks.push(
        "offline UI exposes reconnect and never falls back to another server; API/worker/database restart preserves identity, content, pending approval, buffered input and exactly-once resume",
      );
      await journey.close();
      journey = undefined;
      report.success = true;
    } finally {
      await journey?.close().catch(() => {});
      await app?.close();
      await browser?.close();
      for (const server of servers.reverse()) await server.close();
      await rm(profile, { recursive: true, force: true });
      const output = process.env.INTRICA_MATRIX_REPORT_DIR;
      if (output) {
        const path = join(output, `${mode}.json`);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
      }
      console.log(`[client-matrix] ${JSON.stringify(report)}`);
    }
  });
}
