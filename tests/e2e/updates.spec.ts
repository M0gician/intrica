import { MIN_SERVER_VERSION } from "@intrica/contracts";
import { expect, test } from "@playwright/test";

test("不受支持的服务器版本在进入画布前提示更新，版本与说明仍然可达", async ({ page }) => {
  await page.route("**/api/v2/server", (route) =>
    route.fulfill({
      json: {
        id: "old-server",
        name: "Old server",
        version: "0.1.7",
        apiVersion: "v2",
        web: { enabled: true },
      },
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText(MIN_SERVER_VERSION);
  await expect(page.getByRole("button", { name: "切换画布", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "版本与更新", exact: true }).click();
  await expect(page.getByText("当前版本：0.1.7", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "更新说明" })).toBeVisible();
});

test("版本页区分 Web 和远程后端，检查更新并提供固定镜像升级步骤", async ({ page }) => {
  await page.route("**/api/v2/settings/version", (route) =>
    route.fulfill({
      json: {
        version: "0.2.2",
        deployment: "container",
        apiVersion: "v2",
        schemaVersion: 5,
        commit: null,
      },
    }),
  );
  await page.route("**/api/v2/settings/updates", (route) =>
    route.fulfill({
      json: {
        currentVersion: "0.2.2",
        checkedAt: "2026-09-19T00:00:00Z",
        available: true,
        release: {
          version: "0.3.0",
          url: "https://github.com/M0gician/intrica/releases/tag/v0.3.0",
          publishedAt: "2026-09-19T00:00:00Z",
          apiVersion: "v2",
          schemaVersion: 5,
          serverImage: `ghcr.io/m0gician/intrica-server@sha256:${"a".repeat(64)}`,
          assets: [],
        },
      },
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^(切换画布|Switch canvas)$/ })).toBeVisible();
  await page.keyboard.press("Control+,");
  const dialog = page.getByRole("main", { name: "设置", exact: true });
  await dialog.getByRole("button", { name: "版本与更新", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Web 客户端", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "检查服务器更新", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("0.3.0");
  await dialog.getByText("更新步骤", { exact: true }).click();
  await expect(dialog.locator("pre").first()).toContainText(
    "INTRICA_IMAGE=ghcr.io/m0gician/intrica-server@sha256:",
  );
  await expect(dialog.getByRole("button", { name: "下载并校验更新", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "通用", exact: true }).click();
  await dialog.getByLabel("语言", { exact: true }).selectOption("en");
  const english = page.getByRole("main", { name: "Settings", exact: true });
  await english.getByRole("button", { name: "Version & updates", exact: true }).click();
  await expect(english.getByRole("heading", { name: "Web client", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await english.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  await page.route("**/api/v2/settings/updates", (route) =>
    route.fulfill({
      status: 422,
      json: { error: { code: "UPDATE_RELEASE_NOT_FOUND", message: "Release not found" } },
    }),
  );
  await english.getByRole("button", { name: "Check server updates", exact: true }).click();
  await expect(english.getByRole("alert")).toContainText("public release is not available");
});
