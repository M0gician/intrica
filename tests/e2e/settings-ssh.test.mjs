import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
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
    inspect: async()=>({hostname:"research",platform:"linux",isolation:"bwrap",checkedAt:"2026-10-03T00:00:00Z",agents:0,queued:0,pendingApprovals:0,unknownTools:0}),
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

test("native connection dialogs preserve credentials drafts and require an inspected SSH deployment plan", async () => {
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
    const page = await browser.newPage({ locale: "zh-CN" });
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
            return { alias, supported: true, version: null, service: "inactive" };
          },
          plan: async (input) => {
            window.calls.push({ name: "plan", input });
            if (window.rejectPlan) throw Error("Namespaces unavailable; ask the administrator.");
            return {
              id: "plan-1",
              alias: input.target,
              release: input.release,
              sshTarget: "user@research:22",
              action: "install",
              installation: "/home/user/.local/share/intrica-server",
              config: "/home/user/.config/intrica/server.json",
              currentVersion: null,
              service: "inactive",
              healthy: false,
              asset: { name: "server.tar.gz", size: 42, sha256: "a".repeat(64) },
            };
          },
          apply: async (input) => {
            window.calls.push({ name: "apply", input });
            return { id: "managed", label: "research", baseUrl: "http://127.0.0.1:12345" };
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
    await page.getByRole("button", { name: "部署 Intrica…", exact: true }).click();
    const deployment = page.getByRole("dialog", { name: "通过 SSH 部署", exact: true });
    const release = deployment.getByLabel("目标稳定版本（例如 v0.2.5）");
    await release.fill("v0.2.5");
    await page.keyboard.press("Escape");
    const draft = page.getByRole("alertdialog", { name: "有未保存的修改", exact: true });
    await expect(draft).toBeVisible();
    await expect(draft.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
    await draft.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(release).toHaveValue("v0.2.5");
    await page.evaluate(() => {
      window.rejectPlan = true;
    });
    await deployment.getByRole("button", { name: "生成部署计划", exact: true }).click();
    await expect(deployment.getByRole("alert")).toContainText("Namespaces unavailable");
    await expect(
      deployment.getByRole("button", { name: "部署并保存连接", exact: true }),
    ).toHaveCount(0);
    await expect(release).toHaveValue("v0.2.5");
    await page.evaluate(() => {
      window.rejectPlan = false;
    });
    await deployment.getByRole("button", { name: "生成部署计划", exact: true }).click();
    await expect(deployment.getByText("user@research:22 (research)")).toBeVisible();
    const apply = deployment.getByRole("button", { name: "部署并保存连接", exact: true });
    await expect(apply).toBeDisabled();
    assert.equal(
      await page.evaluate(() => window.calls.filter((item) => item.name === "apply").length),
      0,
    );
    await deployment.getByRole("checkbox").check();
    await apply.click();
    await expect(
      deployment.getByText("部署已验证，SSH 连接已保存。返回列表即可连接。"),
    ).toBeVisible();
    assert.deepEqual(
      await page.evaluate(() => window.calls.find((item) => item.name === "apply").input),
      { id: "plan-1", confirm: true },
    );
    assert.equal(
      await page.evaluate(() => window.calls.filter((item) => item.name === "refresh").length),
      1,
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
