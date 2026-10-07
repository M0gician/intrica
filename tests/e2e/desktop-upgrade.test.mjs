import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { _electron, expect } from "@playwright/test";
import {
  prepareJourney,
  seedPendingApproval,
  verifyJourney,
  verifyPendingApproval,
} from "../fixtures/agent-journey.mjs";

// Opt-in release acceptance: exercise a real installed old app against GitHub,
// then launch the downloaded replacement with the same isolated workspace.
const from = process.env.INTRICA_UPGRADE_FROM_EXECUTABLE;
const expected = process.env.INTRICA_UPGRADE_VERSION;
const candidate = process.env.INTRICA_UPGRADE_TO_EXECUTABLE;
test("desktop upgrade preserves the workspace and updates its bundled server", {
  skip: !from || !expected,
  timeout: 15 * 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "intrica-live-upgrade-"));
  const profile = join(root, "profile");
  const env = {
    ...process.env,
    INTRICA_DESKTOP_PORT: "0",
    MODEL_KIND: "mock",
  };
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "INTRICA_SERVER_URL",
    "DATABASE_URL",
    "PORT",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ])
    delete env[key];
  let app, mount, journey;
  const launch = async (executablePath) => {
    app = await _electron.launch({
      executablePath,
      args: [`--user-data-dir=${profile}`],
      env,
      timeout: 45000,
    });
    app.context().setDefaultTimeout(20000);
    const page = await app.firstWindow();
    await page.waitForURL("intrica://app/**");
    await page.evaluate(() => localStorage.setItem("intrica:language", "en"));
    await page.reload();
    await expect(page.getByRole("button", { name: "Switch canvas", exact: true })).toBeVisible();
    return page;
  };
  const report = { platform: process.platform, from: null, to: expected, checks: [] };
  try {
    let page = await launch(from);
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
          if (!response.ok) throw new Error(`Journey ${path}: ${response.status}`);
          return response.json();
        },
        { path, method, body },
      );
    journey = await prepareJourney(call);
    const pending = await seedPendingApproval(call, journey);
    const initial = await page.evaluate(() => window.intricaDesktop.updates.state());
    report.from = initial.version;
    assert.equal(initial.packaged, true);
    assert.notEqual(initial.version, expected);
    const created = await page.evaluate(async () => {
      const connection = await window.intricaDesktop.connection.get();
      const response = await fetch(`${connection.apiBase}/api/v2/canvases`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Upgrade preservation",
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      if (!response.ok) throw new Error(`Create canvas: ${response.status}`);
      return (await response.json()).node.id;
    });
    let executable = candidate;
    let installer;
    if (!candidate) {
      await expect(page.getByRole("button", { name: /^(切换画布|Switch canvas)$/ })).toBeVisible();
      await page.keyboard.press("Control+,");
      const settings = page.getByRole("main", { name: "Settings", exact: true });
      await settings.getByRole("button", { name: "Version & updates", exact: true }).click();
      await settings.getByRole("button", { name: "Check app updates", exact: true }).click();
      await expect(settings.getByRole("status")).toContainText(expected, { timeout: 45000 });
      const checked = await page.evaluate(() => window.intricaDesktop.updates.state());
      assert.equal(checked.check?.available, true);
      assert.equal(checked.check.release.version, expected);
      assert.ok(checked.asset);
      report.checks.push("old app discovers published release and selects platform installer");
      await settings.getByRole("button", { name: "Download & verify update", exact: true }).click();
      let downloaded;
      const deadline = Date.now() + 12 * 60_000;
      while (Date.now() < deadline) {
        downloaded = await page.evaluate(() => window.intricaDesktop.updates.state());
        if (downloaded.phase !== "downloading") break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      assert.equal(downloaded.phase, "ready", downloaded.error ?? "download did not finish");
      assert.equal(downloaded.downloadedBytes, downloaded.asset.size);
      report.checks.push("download completes with size and SHA-256 verification");
      installer = join(profile, "updates", downloaded.asset.name);
      if (process.env.INTRICA_UPGRADE_OPEN_INSTALLER === "1") {
        await settings
          .getByRole("button", { name: "Open verified installer", exact: true })
          .click();
        await page.getByRole("dialog").getByRole("button", { name: "Open", exact: true }).click();
        assert.equal(
          (await page.evaluate(() => window.intricaDesktop.updates.state())).phase,
          "ready",
        );
        report.checks.push("verified installer opens through the app");
      }
      await app.close();
      app = undefined;
      const installed = join(root, "installed");
      if (installer.endsWith(".dmg")) {
        mount = join(root, "volume");
        execFileSync(
          "hdiutil",
          ["attach", installer, "-readonly", "-nobrowse", "-mountpoint", mount],
          { stdio: "pipe" },
        );
        execFileSync("ditto", [join(mount, "Intrica.app"), join(installed, "Intrica.app")]);
        execFileSync("hdiutil", ["detach", mount], { stdio: "pipe" });
        mount = undefined;
        execFileSync(
          "codesign",
          ["--verify", "--deep", "--strict", join(installed, "Intrica.app")],
          {
            stdio: "pipe",
          },
        );
        executable = join(installed, "Intrica.app/Contents/MacOS/Intrica");
        report.checks.push("downloaded app passes strict code-signature verification");
      } else if (installer.endsWith(".deb")) {
        execFileSync("dpkg-deb", ["-x", installer, installed]);
        executable = join(installed, "opt/Intrica/intrica");
      } else {
        assert.ok(installer.endsWith(".AppImage"));
        // Keep the already executable verified AppImage in its downloaded location.
        env.APPIMAGE_EXTRACT_AND_RUN = "1";
        executable = installer;
      }
    } else {
      await app.close();
      app = undefined;
      report.checks.push("pre-publication candidate replaces previous release");
    }
    page = await launch(executable);
    const after = await page.evaluate(async (published) => {
      const client = await window.intricaDesktop.updates.state();
      const { apiBase } = await window.intricaDesktop.connection.get();
      const server = await (await fetch(`${apiBase}/api/v2/settings/version`)).json();
      const snapshot = await (await fetch(`${apiBase}/api/v2/bootstrap`)).json();
      const check = published ? await window.intricaDesktop.updates.check() : null;
      return { client, server, nodes: snapshot.nodes.map((node) => node.id), check };
    }, !candidate);
    assert.equal(after.client.version, expected);
    assert.equal(after.server.version, expected);
    assert.equal(after.server.schemaVersion, 10);
    assert.ok(after.nodes.includes(created));
    if (!candidate) {
      assert.equal(after.check.check?.available, false);
      assert.equal(after.check.check?.release.version, expected);
      report.checks.push("updated app reports no newer release");
    }
    await verifyPendingApproval(call, journey, pending);
    await journey.start();
    await verifyJourney(call, journey);
    await journey.close();
    journey = undefined;
    report.checks.push(
      "same workspace survives old-to-new app replacement",
      "desktop and bundled server report target version",
      "team, resource grant and pending approval survive; user approval resumes the original call",
      "new installed version completes recruitment, on-demand delegation and reports",
    );
    // Opening a DMG can leave a Finder-mounted volume; only detach this test's file.
    if (
      installer &&
      process.platform === "darwin" &&
      process.env.INTRICA_UPGRADE_OPEN_INSTALLER === "1"
    ) {
      const info = execFileSync("hdiutil", ["info", "-plist"], { encoding: "utf8" });
      const { images } = JSON.parse(
        execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], {
          input: info,
          encoding: "utf8",
        }),
      );
      for (const image of images.filter((entry) => entry["image-path"] === installer))
        for (const entity of image["system-entities"] ?? [])
          if (entity["mount-point"])
            execFileSync("hdiutil", ["detach", entity["mount-point"]], { stdio: "pipe" });
    }
    if (installer)
      assert.deepEqual(
        (await readdir(dirname(installer))).filter((name) => name.endsWith(".part")),
        [],
      );
    console.log(JSON.stringify(report));
  } finally {
    await journey?.close().catch(() => {});
    await app?.close();
    if (mount) execFileSync("hdiutil", ["detach", mount], { stdio: "pipe" });
    await rm(root, { recursive: true, force: true });
  }
});
