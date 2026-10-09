import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { _electron, expect } from "@playwright/test";
import {
  prepareJourney,
  seedPendingApproval,
  verifyJourney,
  verifyPendingApproval,
} from "../../tests/fixtures/agent-journey.mjs";

const directory = dirname(fileURLToPath(import.meta.url));

test("local startup errors show their cause and preserve the existing data", {
  timeout: 30000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "intrica-startup-error-ui-"));
  let app;
  try {
    const data = join(profile, "data/postgres");
    await mkdir(data, { recursive: true });
    await writeFile(join(data, "preserve.txt"), "preserved startup evidence");
    const env = { ...process.env, INTRICA_DESKTOP_PORT: "0" };
    delete env.INTRICA_SERVER_URL;
    delete env.DATABASE_URL;
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: (await import("electron")).default,
      args: [join(directory, "main.mjs"), `--user-data-dir=${profile}`],
      env,
    });
    const page = await app.firstWindow();
    await expect(page.locator("main")).toContainText("PG_VERSION");
    await expect(
      page.getByRole("button", { name: /连接其他服务器|Connect another server/ }),
    ).toHaveCount(0);
    assert.equal(await readFile(join(data, "preserve.txt"), "utf8"), "preserved startup evidence");
  } finally {
    await app?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

async function launch(profile) {
  const env = { ...process.env, INTRICA_DESKTOP_PORT: "0" };
  delete env.INTRICA_SERVER_URL;
  delete env.DATABASE_URL;
  delete env.PORT;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    timeout: 30000,
    executablePath: process.env.INTRICA_TEST_EXECUTABLE || (await import("electron")).default,
    args: [
      ...(process.env.INTRICA_TEST_EXECUTABLE ? [] : [join(directory, "main.mjs")]),
      `--user-data-dir=${profile}`,
    ],
    env,
  });
  app.context().setDefaultTimeout(20000);
  const stderr = [];
  app.process().stderr?.on("data", (chunk) => stderr.push(chunk.toString()));
  try {
    const page = await app.firstWindow();
    await page.waitForURL("intrica://app/**");
    await page.evaluate(() => localStorage.setItem("intrica:language", "zh-CN"));
    await page.reload();
    await expect(page.getByRole("button", { name: "切换画布" })).toBeVisible();
    return { app, page };
  } catch (error) {
    console.error("[desktop startup]", stderr.join(""));
    await app.close().catch(() => {});
    throw error;
  }
}

test("desktop starts its local API and keeps the workspace after relaunch", {
  timeout: 120000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "intrica-standalone-"));
  let first;
  let second;
  let journey;
  try {
    first = await launch(profile);
    await first.page.getByRole("button", { name: "切换画布", exact: true }).click();
    await first.page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = first.page.getByRole("main", { name: "设置", exact: true });
    await settings.getByRole("button", { name: "版本与更新", exact: true }).click();
    await expect(settings.getByRole("heading", { name: "桌面应用", exact: true })).toBeVisible();
    await expect(
      settings
        .locator(".settings-content")
        .getByRole("heading", { name: "当前服务器", exact: true }),
    ).toBeVisible();
    const versions = await first.page.evaluate(async () => {
      const app = await window.intricaDesktop.updates.state();
      const server = await (
        await fetch(
          `${(await window.intricaDesktop.connection.get()).apiBase}/api/v2/settings/version`,
        )
      ).json();
      return { app: app.version, server: server.version };
    });
    assert.equal(versions.app, versions.server);
    await settings.getByRole("button", { name: "返回画布", exact: true }).click();
    const created = await first.page.evaluate(async () => {
      const response = await fetch(
        `${(await window.intricaDesktop.connection.get()).apiBase}/api/v2/canvases`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "独立启动验证", idempotencyKey: crypto.randomUUID() }),
        },
      );
      return { status: response.status, body: await response.json() };
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.node.title, "独立启动验证");
    const call = (path, method = "GET", body) =>
      (second ?? first).page.evaluate(
        async ({ path, method, body }) => {
          const { apiBase } = await window.intricaDesktop.connection.get();
          const r = await fetch(`${apiBase}/api/v2/${path}`, {
            method,
            ...(body === undefined
              ? {}
              : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
          });
          if (!r.ok) throw new Error(`Journey ${path}: ${r.status}`);
          return r.json();
        },
        { path, method, body },
      );
    journey = await prepareJourney(call);
    await journey.start();
    const members = await verifyJourney(call, journey);
    const pending = await seedPendingApproval(call, journey);
    await first.app.close();
    first = undefined;

    second = await launch(profile);
    await verifyPendingApproval(call, journey, pending);
    const snapshot = await second.page.evaluate(async () =>
      (
        await fetch(`${(await window.intricaDesktop.connection.get()).apiBase}/api/v2/bootstrap`)
      ).json(),
    );
    assert.ok(snapshot.nodes.some((node) => node.title === "独立启动验证"));
    const team = await second.page.evaluate(async (canvasId) => {
      const { apiBase } = await window.intricaDesktop.connection.get();
      return (await fetch(`${apiBase}/api/v2/bootstrap?canvasId=${canvasId}`)).json();
    }, journey.board.id);
    for (const member of members)
      assert.ok(team.nodes.some((n) => n.id === member.id && n.managerId === journey.manager.id));
  } finally {
    await journey?.close();
    await second?.app.close();
    await first?.app.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
});
