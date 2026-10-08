import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { createConnections } from "../../apps/desktop/connections.mjs";
import { createSshManager } from "../../apps/desktop/ssh.mjs";
import * as engine from "../../scripts/deploy-server.mjs";
import { releaseManifest } from "../fixtures/releases.mjs";

const webRoot = fileURLToPath(new URL("../../apps/web", import.meta.url));
const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { createServer: createViteServer } = await import(
  pathToFileURL(require.resolve("vite")).href
);
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
function Onboarding() {
  const [profiles, setProfiles] = React.useState([]);
  const [activeId, setActiveId] = React.useState(null);
  const navigation = useSettingsNavigation();
  const actions = {
    profiles, activeId, desktop:true,
    refresh: async()=>setProfiles(await window.listConnections()),
    connect: async profile=>{await window.activateConnection(profile.id);setActiveId(profile.id);},
    disconnect: async profile=>{await window.disconnectConnection(profile.id);setActiveId(null);},
    save: window.saveConnection,
    remove: window.removeConnection,
  };
  return h("main",{className:"settings-page"},
    h(Servers,{actions,register:navigation.register,navigate:navigation.navigate}),
    navigation.pending&&h(UnsavedDialog,{saving:navigation.saving,onStay:navigation.stay,onDiscard:navigation.discard,onSave:navigation.canSave?navigation.save:undefined}));
}
createRoot(document.getElementById("root")).render(h(Onboarding));
</script></body></html>`;

test("SSH onboarding confirms a shared-engine deployment and activates its private connection vault in a native browser", async () => {
  const dir = await mkdtemp(join(tmpdir(), "intrica-onboarding-flow-"));
  const archive = Buffer.from("isolated test-only native release");
  const token = "only-main-process-knows-this-token";
  let installed = false,
    keychainCalls = 0,
    authenticatedRequests = 0,
    ssh,
    browser,
    renderer;
  const calls = [];
  const server = createHttpServer((request, response) => {
    if (!installed) {
      response.writeHead(503).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    authenticatedRequests++;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify(
        request.url === "/api/v2/server"
          ? { id: "new-machine-server", apiVersion: "v2" }
          : { authenticated: true },
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const vault = await createConnections({
    userData: dir,
    safeStorage: {
      isEncryptionAvailable: () => {
        keychainCalls++;
        return true;
      },
      encryptString: () => assert.fail("SSH credentials must not be encrypted or persisted"),
    },
    resolveSsh: (alias, target) => ssh.target(alias, target),
  });
  ssh = createSshManager({
    engine: {
      ...engine,
      deployServer: (options, runtime) =>
        engine.deployServer(options, {
          ...runtime,
          fetchImpl: async (url) =>
            url.endsWith("/intrica-update.json")
              ? Response.json(releaseManifest("0.2.5", archive))
              : new Response(archive),
        }),
      runCommand: async (command, args, options = {}) => {
        calls.push({ command, args, ...(options.input ? { input: options.input } : {}) });
        if (command === "ssh" && args.includes("-G"))
          return "user example\nhostname empty-linux-machine\nport 22\n";
        if (options.input === engine.preflightScript)
          return "platform=linux\narchitecture=x64\ninstallation=/home/example/.local/share/intrica-server\nconfig=/home/example/.config/intrica/server.json\nconfigured=no\ncurrent=\nrelease=\nservice=inactive\nhealthy=no\nsandbox=required\nsandboxAvailable=no\n";
        if (options.input?.startsWith("umask 077\nmktemp")) return "/tmp/intrica-deploy.ABC1234567";
        if (options.inputFile) {
          assert.deepEqual(await readFile(options.inputFile), archive);
          return "";
        }
        if (options.input?.startsWith("#!/usr/bin/env bash")) {
          assert.match(options.input, /systemctl --user/);
          installed = true;
          return "ready (no credentials printed)";
        }
        if (options.input?.startsWith("rm -f --")) return "";
        if (options.input?.includes("process.stdout.write(JSON.stringify")) {
          assert.equal(installed, true);
          return JSON.stringify({ host: "127.0.0.1", port: 3001, token });
        }
        throw Error("Unexpected subprocess");
      },
    },
    aliases: async () => ["empty-machine"],
    tunnel: async () => ({ baseUrl, alive: () => true, close() {} }),
    saveManaged: (input) => vault.saveManaged(input),
  });
  try {
    renderer = await createViteServer({
      root: webRoot,
      configFile: `${webRoot}/vite.config.ts`,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0 },
      plugins: [
        {
          name: "native-ssh-onboarding",
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url !== "/__ssh_onboarding") return next();
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
    await renderer.listen();
    browser = await chromium.launch();
    const page = await browser.newPage({ locale: "zh-CN" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.exposeFunction("sshConnect", (target) => ssh.connect(target));
    await page.exposeFunction("disconnectConnection", (id) => vault.disconnect(id));
    await page.exposeFunction("sshAliases", () => ssh.aliases());
    await page.exposeFunction("sshInspect", (alias) => ssh.inspect(alias));
    await page.exposeFunction("sshPlan", (input) => ssh.plan(input));
    await page.exposeFunction("sshApply", (input) => ssh.apply(input));
    await page.exposeFunction("listConnections", () =>
      vault.list().filter((profile) => !profile.local),
    );
    await page.exposeFunction("saveConnection", (input) => vault.save(input));
    await page.exposeFunction("removeConnection", (profile) => vault.remove(profile.id));
    await page.exposeFunction("activateConnection", (id) => vault.activate(id));
    await page.addInitScript(() => {
      localStorage.setItem("intrica:language", "zh-CN");
      window.intricaDesktop = {
        ssh: {
          connect: (target) => window.sshConnect(target),
          aliases: () => window.sshAliases(),
          inspect: (alias) => window.sshInspect(alias),
          plan: (input) => window.sshPlan(input),
          apply: (input) => window.sshApply(input),
        },
      };
    });
    await page.goto(`http://127.0.0.1:${renderer.httpServer.address().port}/__ssh_onboarding`);
    await page.getByRole("button", { name: "添加服务器", exact: true }).click();
    await page.getByRole("radio", { name: "empty-machine", exact: true }).check();
    await page.getByRole("button", { name: "部署 Intrica…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "通过 SSH 部署", exact: true });
    await dialog.getByLabel("目标稳定版本").fill("v0.2.5");
    await expect(
      dialog.getByText("此主机的工具沙箱不可用。请配置 Bubblewrap，或明确选择无沙箱模式。"),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "生成部署计划", exact: true })).toBeDisabled();
    await dialog.getByRole("checkbox", { name: "无沙箱模式", exact: true }).check();
    await expect(dialog.getByRole("alert")).toContainText("服务账号");
    await dialog.getByRole("button", { name: "生成部署计划", exact: true }).click();
    await expect(dialog.getByText("example@empty-linux-machine:22 (empty-machine)")).toBeVisible();
    assert.equal(installed, false);
    assert.equal(
      calls.some((call) => call.args.includes("download")),
      false,
    );
    const deploy = dialog.getByRole("button", { name: "部署并保存连接", exact: true });
    await expect(deploy).toBeDisabled();
    await dialog
      .getByRole("checkbox", {
        name: "我已核对服务器、版本和工具执行权限，同意部署并保存连接",
        exact: true,
      })
      .check();
    await dialog.getByRole("checkbox", { name: "无沙箱模式", exact: true }).uncheck();
    await expect(deploy).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "生成部署计划", exact: true })).toBeDisabled();
    await dialog.getByRole("checkbox", { name: "无沙箱模式", exact: true }).check();
    await dialog.getByRole("button", { name: "生成部署计划", exact: true }).click();
    await expect(deploy).toBeDisabled();
    await dialog
      .getByRole("checkbox", {
        name: "我已核对服务器、版本和工具执行权限，同意部署并保存连接",
        exact: true,
      })
      .check();
    await deploy.click();
    await expect(dialog.getByText("部署已验证，SSH 连接已保存。返回列表即可连接。")).toBeVisible();
    assert.equal(installed, true);
    const profile = vault.list().find((entry) => entry.sshAlias === "empty-machine");
    assert.equal(profile.hasToken, true);
    assert.equal(profile.persistent, true);
    assert.equal(keychainCalls, 0);
    assert.ok(!JSON.stringify(profile).includes(token));
    assert.ok(!(await readFile(join(dir, "connections.json"), "utf8")).includes(token));
    assert.ok(!(await page.locator("body").innerText()).includes(token));
    await dialog.getByRole("button", { name: "返回服务器列表", exact: true }).click();
    await page.getByRole("button", { name: `管理连接：${profile.label}`, exact: true }).click();
    await page.getByRole("button", { name: "连接详情", exact: true }).click();
    await expect(page.getByText("令牌：通过 SSH 获取")).toBeVisible();
    await page.getByRole("switch", { name: `连接服务器：${profile.label}`, exact: true }).click();
    await expect(
      page.getByRole("switch", { name: `连接服务器：${profile.label}`, exact: true }),
    ).toBeChecked();
    await expect(page.getByText("当前使用", { exact: true })).toBeVisible();
    assert.equal(vault.get().profileId, profile.id);
    assert.equal(vault.get().baseUrl, baseUrl);
    assert.ok(authenticatedRequests > 0);
    assert.equal(keychainCalls, 0);
    assert.ok(!(await page.content()).includes(token));
    const priorBinding = vault.get().bindingId;
    await page.getByRole("switch", { name: `连接服务器：${profile.label}`, exact: true }).click();
    await expect(
      page.getByRole("switch", { name: `连接服务器：${profile.label}`, exact: true }),
    ).not.toBeChecked();
    assert.throws(() => vault.get(), /unavailable/);
    assert.equal(
      (await vault.forward(new Request(`${baseUrl}/api/v2/server`), priorBinding, "/api/v2/server"))
        .status,
      410,
    );
    await page.getByRole("button", { name: "添加服务器", exact: true }).click();
    await page.getByRole("button", { name: "手动添加服务器…", exact: true }).click();
    const manual = page.getByRole("dialog", { name: "添加服务器", exact: true });
    await expect(manual.getByLabel("连接方式", { exact: true })).toHaveValue("ssh");
    await manual.getByLabel("主机地址", { exact: true }).fill("manual.example.test");
    await manual.getByLabel("用户名", { exact: true }).fill("researcher");
    await manual.getByLabel("端口", { exact: true }).fill("2222");
    await manual.getByRole("button", { name: "添加", exact: true }).click();
    await expect(manual).toHaveCount(0);
    const savedManual = vault.list().find((profile) => profile.sshTarget);
    assert.deepEqual(savedManual.sshTarget, {
      hostname: "manual.example.test",
      username: "researcher",
      port: 2222,
    });
    assert.equal(savedManual.label, "researcher@manual.example.test");
    const manualCall = calls.filter((call) => call.command === "ssh").at(-1);
    assert.ok(manualCall.args.includes("HostName=manual.example.test"));
    assert.ok(manualCall.args.includes("StrictHostKeyChecking=yes"));
    assert.equal(manualCall.args[manualCall.args.indexOf("-l") + 1], "researcher");
    assert.equal(manualCall.args[manualCall.args.indexOf("-p") + 1], "2222");
    await page
      .getByRole("switch", { name: `连接服务器：${savedManual.label}`, exact: true })
      .click();
    await expect(
      page.getByRole("switch", { name: `连接服务器：${savedManual.label}`, exact: true }),
    ).toBeChecked();
    assert.equal(vault.get().profileId, savedManual.id);
    assert.ok(!(await readFile(join(dir, "connections.json"), "utf8")).includes(token));
    const count = calls.length;
    await assert.rejects(
      ssh.connect({ hostname: "host\nProxyCommand=evil", username: "user", port: 22 }),
      /Invalid SSH/,
    );
    assert.equal(calls.length, count);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await renderer?.close();
    vault.close();
    ssh.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
