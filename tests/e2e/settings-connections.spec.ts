import { expect, test } from "@playwright/test";

test("connection rows distinguish the current server from unchecked saved addresses", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "intrica:servers",
      JSON.stringify([
        { id: "saved", label: "Saved research server", baseUrl: "https://research.example.test" },
      ]),
    ),
  );
  let checks = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v2/settings/diagnostics") checks++;
  });
  await page.goto("/#settings/servers");
  const settings = page.getByRole("main", { name: "设置", exact: true });
  const saved = settings.locator(".connection-row").filter({ hasText: "Saved research server" });
  await expect(saved.getByText("https://research.example.test")).toBeVisible();
  await expect(saved).not.toContainText("当前使用");
  await expect(saved.getByRole("button", { name: "打开", exact: true })).toBeVisible();
  expect(checks).toBe(0);
  const active = settings.locator(".connection-row").filter({ hasText: "当前使用" });
  await active.getByRole("button", { name: "检查连接", exact: true }).click();
  await expect(active).toContainText("可访问");
  expect(checks).toBe(1);
  await expect(saved.getByText("https://research.example.test")).toBeVisible();
});

test("connection maintenance is anchored and editor drafts survive Escape", async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem("intrica:servers") !== null) return;
    localStorage.setItem(
      "intrica:servers",
      JSON.stringify([
        { id: "saved", label: "Research server", baseUrl: "https://research.example.test" },
      ]),
    );
  });
  await page.setViewportSize({ width: 480, height: 720 });
  await page.goto("/#settings/servers");
  const more = page.getByRole("button", { name: "管理连接：Research server", exact: true });
  await more.focus();
  await more.press("Space");
  const menu = page.locator(".connection-menu:popover-open");
  await expect(menu).toBeVisible();
  await expect(menu).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
  await more.click();
  await page.getByRole("button", { name: "编辑连接", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑连接", exact: true });
  const name = editor.getByLabel("名称", { exact: true });
  await expect(name).toBeFocused();
  await name.fill("Research draft");
  await page.keyboard.press("Escape");
  const unsaved = page.getByRole("alertdialog", { name: "有未保存的修改", exact: true });
  await expect(unsaved).toBeVisible();
  await unsaved.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(name).toHaveValue("Research draft");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator(".connection-row").filter({ hasText: "Research draft" })).toBeVisible();
  await page.reload();
  await expect(page.locator(".connection-row").filter({ hasText: "Research draft" })).toBeVisible();
});

test("connection validation focuses the incomplete field and removal names its scope", async ({
  page,
}) => {
  await page.goto("/#settings/servers");
  await page.getByRole("button", { name: "添加服务器", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "添加服务器连接", exact: true });
  await editor.getByLabel("名称", { exact: true }).fill("Test connection");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor.getByLabel("服务器地址", { exact: true })).toBeFocused();
  await expect(editor.getByRole("alert")).toBeVisible();
  await editor.getByLabel("服务器地址", { exact: true }).fill("research.example.test");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await page.getByRole("button", { name: "管理连接：Test connection", exact: true }).click();
  await page.getByRole("button", { name: "移除连接", exact: true }).click();
  const removal = page.getByRole("dialog", { name: "移除连接", exact: true });
  await expect(removal).toContainText("Test connection");
  await expect(removal).toContainText("服务器上的任务和数据会保留");
  await removal.getByRole("button", { name: "确认移除连接", exact: true }).click();
  await expect(page.locator(".connection-row").filter({ hasText: "Test connection" })).toHaveCount(
    0,
  );
});

test("updates show the current version before optional build diagnostics", async ({ page }) => {
  await page.goto("/#settings/updates");
  const client = page.locator(".settings-update-card").first();
  await expect(client.getByText(/当前版本/)).toBeVisible();
  const details = client.locator(".build-details");
  await expect(details).not.toHaveAttribute("open");
  await expect(client.getByRole("button", { name: "复制构建诊断信息", exact: true })).toHaveCount(
    0,
  );
  await details.locator("summary").click();
  await expect(client.getByRole("button", { name: "复制构建诊断信息", exact: true })).toBeVisible();
});
