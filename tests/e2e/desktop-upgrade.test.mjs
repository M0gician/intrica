import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron, chromium, expect } from "@playwright/test";
import {
  prepareJourney,
  seedPendingApproval,
  until,
  verifyJourney,
  verifyPendingApproval,
} from "../fixtures/agent-journey.mjs";

// Opt-in platform acceptance. Product code must quit, replace and restart the app.
// The starting app MUST be a disposable installation, never a personal installation.
const from = process.env.INTRICA_UPGRADE_FROM_EXECUTABLE;
const expected = process.env.INTRICA_UPGRADE_VERSION;
const transitionDmg = process.env.INTRICA_UPGRADE_TRANSITION_DMG;
const freePort = async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};

test("installed app updates through product controls and validates the original workspace", {
  skip: !from || !expected || process.env.INTRICA_UPGRADE_DISPOSABLE !== "1",
  timeout: 15 * 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "intrica-automatic-upgrade-"));
  const profile = join(root, "profile"),
    port = await freePort();
  const args = [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`];
  const env = { ...process.env, INTRICA_DESKTOP_PORT: "0" };
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "INTRICA_SERVER_URL",
    "INTRICA_ACCESS_TOKEN",
    "DATABASE_URL",
    "PORT",
    "MODEL_KIND",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ])
    delete env[key];
  let app, browser, page, journey, mount, launcher;
  const call = (path, method = "GET", body) =>
    page.evaluate(
      async ({ path, method, body }) => {
        const { apiBase } = await window.intricaDesktop.connection.get();
        const response = await fetch(`${apiBase}/api/v2/${path}`, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        });
        if (!response.ok) throw new Error(`Acceptance ${path}: ${response.status}`);
        return response.json();
      },
      { path, method, body },
    );
  try {
    app = await _electron.launch({ executablePath: from, args, env, timeout: 45000 });
    page = await app.firstWindow();
    await page.waitForURL("intrica://app/**");
    await page.evaluate(() => localStorage.setItem("intrica:language", "en"));
    await page.reload();
    await expect(page.getByRole("button", { name: "Switch canvas", exact: true })).toBeVisible();
    const initial = await page.evaluate(() => window.intricaDesktop.updates.state());
    assert.equal(initial.packaged, true);
    assert.notEqual(initial.version, expected);
    journey = await prepareJourney(call);
    const pending = await seedPendingApproval(call, journey);
    const identity = await call("server");
    const created = (
      await call("canvases", "POST", {
        title: "Upgrade preservation",
        idempotencyKey: randomUUID(),
      })
    ).node.id;
    const sentinel = `draft-${randomUUID()}`;
    await page.evaluate(
      (text) => localStorage.setItem("intrica:upgrade-acceptance", text),
      sentinel,
    );
    const oldProcess = app.process();
    if (transitionDmg) {
      assert.equal(process.platform, "darwin");
      mount = `/Volumes/Intrica-Upgrade-${randomUUID()}`;
      execFileSync(
        "hdiutil",
        ["attach", transitionDmg, "-readonly", "-nobrowse", "-mountpoint", mount],
        { stdio: "pipe" },
      );
      // Opening the new app and pressing its native install action are user actions.
      // The test never terminates the old app, copies app files, or starts the replacement.
      launcher = spawn(join(mount, "Intrica.app/Contents/MacOS/Intrica"), args, {
        env,
        stdio: "ignore",
      });
      await until(() => {
        try {
          execFileSync(
            "osascript",
            [
              "-e",
              `tell application "System Events" to tell (first application process whose unix id is ${launcher.pid}) to click button "Install and restart" of window 1`,
            ],
            { stdio: "pipe" },
          );
          return true;
        } catch {
          return false;
        }
      }, 30000);
    } else {
      await page.keyboard.press("Control+,");
      const settings = page.getByRole("main", { name: "Settings", exact: true });
      await settings.getByRole("button", { name: "Version & updates", exact: true }).click();
      const desktop = settings
        .locator(".settings-update-card")
        .filter({ has: page.getByRole("heading", { name: "Desktop app", exact: true }) });
      const check = desktop.getByRole("button", { name: "Check for updates", exact: true });
      if (!(await check.isVisible()))
        await desktop.getByText("Background update preferences", { exact: true }).click();
      await check.click();
      await expect(desktop.getByRole("status")).toContainText(expected, { timeout: 45000 });
      await desktop.getByRole("button", { name: "Update and restart", exact: true }).click();
    }
    await until(() => oldProcess.exitCode !== null || oldProcess.signalCode !== null, 12 * 60_000);
    // Attach to the restarted process. This is deliberately not _electron.launch().
    browser = await until(async () => {
      try {
        return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 });
      } catch {
        return null;
      }
    }, 90000);
    page = await until(
      () =>
        browser
          .contexts()
          .flatMap((context) => context.pages())
          .find((item) => item.url().startsWith("intrica://app/")),
      30000,
    );
    const completed = await until(async () => {
      const state = await page.evaluate(() => window.intricaDesktop.updates.state());
      if (state.phase === "error") throw new Error(state.error);
      return state.phase === "complete" ? state : null;
    }, 90000);
    const server = await call("settings/version");
    assert.equal(completed.version, expected);
    assert.equal(server.version, expected);
    const journal = JSON.parse(await readFile(join(profile, "updates/operation.json"), "utf8"));
    assert.equal(server.schemaVersion, journal.targetSchemaVersion);
    assert.equal((await call("server")).id, identity.id);
    assert.ok((await call("bootstrap")).nodes.some((node) => node.id === created));
    assert.equal(
      await page.evaluate(() => localStorage.getItem("intrica:upgrade-acceptance")),
      sentinel,
    );
    await verifyPendingApproval(call, journey, pending);
    await journey.start();
    await verifyJourney(call, journey, [pending.request.id]);
    console.log(
      JSON.stringify({
        platform: process.platform,
        from: initial.version,
        to: expected,
        transition: Boolean(transitionDmg),
        checks: [
          "product quit, replacement and restart",
          "actual client and server version",
          "same server identity and workspace",
          "persisted browser storage",
          "pending approval and original call recovery",
        ],
      }),
    );
  } finally {
    await journey?.close().catch(() => {});
    if (page && browser) {
      // Cleanup only, after assertions. Closing the product window uses its normal shutdown path.
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
    }
    await app?.close().catch(() => {});
    if (launcher?.exitCode === null) launcher.kill("SIGTERM");
    if (mount) execFileSync("hdiutil", ["detach", mount], { stdio: "pipe" });
    await rm(root, { recursive: true, force: true });
  }
});
