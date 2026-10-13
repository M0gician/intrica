import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium, expect } from "@playwright/test";

const webRoot = fileURLToPath(new URL("../../apps/web", import.meta.url));
const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div id="root"></div>
<script type="module">
import React from "react";
import {createRoot} from "react-dom/client";
import {Servers} from "/src/features/settings/Servers.tsx";
import {useSettingsNavigation} from "/src/features/settings/use-settings-navigation.ts";
import {UnsavedDialog} from "/src/features/settings/UnsavedDialog.tsx";
import "/src/styles.css";
import "/src/features/settings/settings.css";
const h = React.createElement;
function Fixture() {
  const [profiles, setProfiles] = React.useState([{id:"saved",label:"Research server",baseUrl:"http://research.test:3001",hasToken:true,persistent:true}]);
  const [activeId, setActiveId] = React.useState("saved");
  const navigation = useSettingsNavigation();
  const actions = {
    desktop:true, profiles, activeId,
    save: async input => { window.calls.push({name:"save",input}); return input; },
    connect: async profile => setActiveId(profile.id),
    disconnect: async()=>setActiveId(null),
    remove: async profile => setProfiles(previous=>previous.filter(item=>item.id!==profile.id)),
    refresh: async()=>window.calls.push({name:"refresh"}),
    inspect: async()=>({hostname:"research",platform:"linux",sandboxStatus:window.sandboxStatus??"enabled",checkedAt:"2026-10-03T00:00:00Z",agents:0,queued:0,pendingApprovals:0,unknownTools:0}),
    forgetToken: async profile => {
      window.calls.push({name:"forgetToken",id:profile.id});
      setProfiles(previous=>previous.map(item=>item.id===profile.id?{...item,hasToken:false}:item));
      setActiveId(null);
    },
  };
  return h("main",{className:"settings-page"},
    h(Servers,{actions,register:navigation.register,navigate:navigation.navigate}),
    navigation.pending && h(UnsavedDialog,{saving:navigation.saving,onStay:navigation.stay,onDiscard:navigation.discard,onSave:navigation.canSave?navigation.save:undefined}));
}
createRoot(document.getElementById("root")).render(h(Fixture));
</script></body></html>`;

test("connection dialogs preserve credential drafts and restore one-click installation progress", async () => {
  const server = await createServer({
    root: webRoot,
    configFile: `${webRoot}/vite.config.ts`,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "settings-connection-browser-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__settings_connections") return next();
            try {
              response.setHeader("Content-Type", "text/html");
              response.end(await vite.transformIndexHtml(request.url, html));
            } catch (error) {
              next(error);
            }
          });
        },
      },
    ],
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const context = await browser.newContext({ locale: "zh-CN" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("intrica:language", "zh-CN");
      window.calls = [];
      window.intricaDesktop = {
        ssh: {
          aliases: async () => ["research"],
          inspect: async (alias) => {
            window.calls.push({ name: "inspect", alias });
            if (window.inspectFails) throw new Error("Fixture connection unavailable");
            return {
              alias,
              supported: true,
              version: null,
              service: "inactive",
              sandbox: "required",
              sandboxAvailable: true,
            };
          },
          state: async () => ({ release: "v0.2.5", operation: window.sshOperation ?? null }),
          install: async (input) => {
            window.calls.push({ name: "install", input });
            window.sshOperation = {
              id: input.operationId ?? "install-1",
              alias: "research",
              target: input.target,
              release: "v0.2.5",
              sandbox: input.sandbox,
              phaseStartedAt: Date.now(),
              phase: window.rejectInstall ? "failed" : "uploading",
              cancellable: true,
              transferredBytes: 20,
              totalBytes: 100,
              error: window.rejectInstall
                ? { code: "LINGER_PERMISSION_REQUIRED", remediation: "loginctl enable-linger 1001" }
                : null,
            };
            return window.intricaDesktop.ssh.state();
          },
          cancel: async () => {
            window.sshOperation.phase = "cancelled";
            return window.intricaDesktop.ssh.state();
          },
        },
      };
    });
    const url = `http://127.0.0.1:${server.httpServer.address().port}/__settings_connections`;
    await page.goto(url);
    await page.getByRole("button", { name: "管理连接：Research server", exact: true }).click();
    await page.getByRole("button", { name: "检查此服务器", exact: true }).click();
    await expect(page.locator(".connection-details")).toContainText("research · linux");
    await expect(page.locator(".connection-details")).toContainText("0 / 0 / 0 / 0");
    await expect(page.locator(".connection-details")).toContainText("沙箱已启用");
    for (const [status, label] of [
      ["disabled", "无沙箱模式"],
      ["unavailable", "沙箱不可用"],
    ]) {
      await page.evaluate((value) => {
        window.sandboxStatus = value;
      }, status);
      await page.getByRole("button", { name: "管理连接：Research server", exact: true }).click();
      await page.getByRole("button", { name: "检查此服务器", exact: true }).click();
      await expect(page.locator(".connection-details")).toContainText(label);
    }
    await expect(
      page.getByRole("switch", { name: "连接服务器：Research server", exact: true }),
    ).toBeChecked();
    await page.getByRole("button", { name: "管理连接：Research server", exact: true }).click();
    await page.getByRole("button", { name: "编辑连接", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "编辑连接", exact: true });
    await editor.getByLabel("名称", { exact: true }).fill("Retained connection draft");
    await editor.getByLabel("访问令牌", { exact: true }).fill("replacement-draft");
    await editor.getByRole("button", { name: "清除此设备保存的令牌", exact: true }).click();
    assert.equal(
      await page.evaluate(() => window.calls.filter((item) => item.name === "forgetToken").length),
      0,
    );
    await editor.getByRole("button", { name: "确认清除", exact: true }).click();
    await expect(editor.getByText("已清除此设备保存的令牌。其他输入保持不变。")).toBeVisible();
    await expect(editor.getByLabel("名称", { exact: true })).toHaveValue(
      "Retained connection draft",
    );
    await expect(editor.getByLabel("访问令牌", { exact: true })).toHaveValue("replacement-draft");
    assert.equal(
      await page.evaluate(() => window.calls.filter((item) => item.name === "save").length),
      0,
    );

    await page.goto(url);
    await page.getByRole("button", { name: "添加服务器", exact: true }).click();
    await page.getByRole("radio", { name: "research", exact: true }).check();
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    const deployment = page.getByRole("dialog", { name: "安装并连接", exact: true });
    await expect(deployment.getByLabel("目标稳定版本")).toHaveCount(0);
    await expect(deployment.getByText("v0.2.5", { exact: true })).toBeVisible();
    await expect(deployment.getByRole("radio", { name: "隔离运行", exact: true })).toBeChecked();
    await expect(deployment.locator(".ssh-install-details")).not.toHaveAttribute("open");
    await expect(deployment.locator('[data-variant="primary"]')).toHaveCount(1);
    await deployment.getByRole("radio", { name: "使用服务账号权限", exact: true }).check();
    await expect(deployment.getByText("工作目录不会限制工具的访问范围。")).toBeVisible();
    assert.equal(
      await page.evaluate(() => window.calls.filter((item) => item.name === "install").length),
      0,
    );
    await deployment.screenshot({ path: "/tmp/intrica-ssh-setup-ready.png" });
    for (const width of [320, 480]) {
      await page.setViewportSize({ width, height: 740 });
      assert.ok(await deployment.evaluate((element) => element.scrollWidth <= element.clientWidth));
      await expect(
        deployment.getByRole("button", { name: "安装并连接", exact: true }),
      ).toBeVisible();
    }
    await deployment.screenshot({ path: "/tmp/intrica-ssh-setup-narrow.png" });
    const violations = (
      await new AxeBuilder({ page }).include(".ssh-setup").analyze()
    ).violations.filter((item) => ["critical", "serious"].includes(item.impact));
    assert.deepEqual(violations, []);
    await page.setViewportSize({ width: 1000, height: 800 });
    await deployment.getByRole("radio", { name: "隔离运行", exact: true }).check();
    await page.evaluate(() => {
      window.rejectInstall = true;
    });
    await deployment.getByRole("button", { name: "安装并连接", exact: true }).click();
    await expect(deployment.getByRole("alert")).toContainText("需要管理员为此账号启用后台运行");
    await expect(
      deployment.getByText("loginctl enable-linger 1001", { exact: true }),
    ).toBeVisible();
    await page.evaluate(() => {
      window.rejectInstall = false;
    });
    await deployment.getByRole("button", { name: "重新检查并继续", exact: true }).click();
    await expect(deployment.getByRole("progressbar")).toHaveAttribute("value", "20");
    await expect(deployment.locator('[aria-current="step"]')).toContainText("传输文件");
    await expect(deployment.getByRole("radio")).toHaveCount(0);
    await deployment.screenshot({ path: "/tmp/intrica-ssh-setup-progress.png" });
    for (const language of ["zh-CN", "en"]) {
      await page.evaluate(async (language) => {
        const { setLanguage } = await import("/src/i18n/index.ts");
        await setLanguage(language);
      }, language);
      await page.setViewportSize({ width: 320, height: 740 });
      const panel = page.getByRole("dialog");
      assert.ok(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth));
      for (const step of await panel.locator(".ssh-install-steps li").all()) {
        assert.ok(await step.evaluate((element) => element.scrollWidth <= element.clientWidth));
      }
      await panel.screenshot({ path: `/tmp/intrica-ssh-setup-progress-${language}-narrow.png` });
    }
    await page.evaluate(async () => {
      const { setLanguage } = await import("/src/i18n/index.ts");
      await setLanguage("zh-CN");
    });
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.keyboard.press("Escape");
    await expect(deployment).toHaveCount(0);
    await page.getByRole("button", { name: "查看服务器安装", exact: true }).click();
    await expect(deployment.getByRole("progressbar")).toHaveAttribute("value", "20");
    await page.evaluate(() => {
      window.sshOperation.phase = "completed";
    });
    await expect(deployment.getByText("安装完成，已连接服务器", { exact: true })).toBeVisible();
    await expect(deployment.getByRole("button", { name: "安装并连接", exact: true })).toHaveCount(
      0,
    );
    await expect(deployment.locator('[data-variant="primary"]')).toHaveCount(1);
    await deployment.screenshot({ path: "/tmp/intrica-ssh-setup-complete.png" });
    const installs = await page.evaluate(() =>
      window.calls.filter((item) => item.name === "install"),
    );
    assert.deepEqual(
      installs.map((call) => call.input),
      [
        { target: "research", sandbox: "required" },
        { target: "research", sandbox: "required", operationId: "install-1" },
      ],
    );
    await deployment.getByRole("button", { name: "返回服务器列表", exact: true }).click();
    await page.reload();
    await page.evaluate(() => {
      window.inspectFails = true;
    });
    await page.getByRole("button", { name: "添加服务器", exact: true }).click();
    await page.getByRole("radio", { name: "research", exact: true }).check();
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expect(deployment.getByRole("alert")).toContainText("Fixture connection unavailable");
    await page.evaluate(() => {
      window.inspectFails = false;
    });
    await deployment.getByRole("button", { name: "重新检查服务器", exact: true }).click();
    await expect(deployment.getByRole("button", { name: "安装并连接", exact: true })).toBeEnabled();
    assert.equal(
      await page.evaluate(() => window.calls.filter((item) => item.name === "install").length),
      0,
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
