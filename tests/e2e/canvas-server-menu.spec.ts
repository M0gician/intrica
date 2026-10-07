import { expect, test } from "@playwright/test";
import { UI_URL } from "./environment.mjs";

test("canvas menu exposes the current server, keyboard switching and server management", async ({
  page,
}) => {
  const label = `Remote ${"long-name ".repeat(30)}`;
  await page.addInitScript(
    ({ label }) =>
      localStorage.setItem(
        "intrica:servers",
        JSON.stringify([{ id: "remote", label, baseUrl: "https://intrica.example.test" }]),
      ),
    { label },
  );
  await page.setViewportSize({ width: 360, height: 480 });
  await page.goto("/");
  await page.getByRole("button", { name: "切换画布", exact: true }).click();
  const switcher = page.getByRole("button", { name: "切换服务器", exact: true });
  await expect(switcher).toContainText(UI_URL);
  await switcher.press("ArrowDown");
  const servers = page.getByRole("menu", { name: "切换服务器", exact: true });
  const current = servers.locator('[aria-checked="true"]');
  await expect(current).toBeFocused();
  await current.press("ArrowDown");
  const remote = servers.getByRole("menuitemradio", { name: label, exact: true });
  await expect(remote).toBeFocused();
  await expect(remote).toBeInViewport();
  expect(await servers.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  const menuBox = (await servers.boundingBox())!;
  const currentBox = (await current.boundingBox())!;
  const footerBox = (await servers
    .getByRole("menuitem", { name: "管理服务器", exact: true })
    .boundingBox())!;
  expect(currentBox.x - menuBox.x).toBeCloseTo(
    menuBox.x + menuBox.width - currentBox.x - currentBox.width,
    1,
  );
  expect(currentBox.x).toBeCloseTo(footerBox.x, 1);
  expect(currentBox.width).toBeCloseTo(footerBox.width, 1);
  await page.screenshot({ path: test.info().outputPath("server-menu.png") });
  await remote.press("Escape");
  await expect(servers).toHaveCount(0);
  await expect(switcher).toBeFocused();
  await switcher.click();
  await servers.getByRole("menuitem", { name: "管理服务器", exact: true }).click();
  const settings = page.getByRole("main", { name: "设置", exact: true });
  await expect(settings.getByRole("heading", { name: "服务器连接", exact: true })).toBeVisible();
  await expect(settings).toContainText(label);
  await settings.getByRole("button", { name: "返回画布", exact: true }).click();
  await page.getByRole("button", { name: "切换画布", exact: true }).click();
  await switcher.click();
  await page.route("https://intrica.example.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Remote Intrica</h1>" }),
  );
  await remote.click();
  await expect(page).toHaveURL("https://intrica.example.test/");
  await expect(page.getByRole("heading", { name: "Remote Intrica" })).toBeVisible();
});
