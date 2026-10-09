import { randomUUID } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serverOrigin } from "@intrica/client";
import { startLocalBackend } from "@intrica/server/runtime";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  safeStorage,
  session,
  shell,
  WebContentsView,
} from "electron";
import { createConnections } from "./connections.mjs";
import { createFileDownloads } from "./files.mjs";
import { registerAppProtocol } from "./protocol.mjs";
import { createSshManager } from "./ssh.mjs";
import { createUpdater } from "./updates.mjs";
import { createWebPreview } from "./web-preview.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
let build;
try {
  build = JSON.parse(readFileSync(resolve(directory, "assets/build.json"), "utf8"));
} catch {}
let apiUrl;
let backend;
let mainWindow;
let quitting = false;
let shutdownComplete = false;
let startup;
let nativeMessage = (key) => key;
let agentBrowserCommand;
const browserToken = randomUUID();
protocol.registerSchemesAsPrivileged([
  {
    scheme: "intrica",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);
let connections;
let sshManager;
let updater;
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/__intrica_browser") {
    if (
      request.method !== "POST" ||
      request.headers["x-intrica-browser-token"] !== browserToken ||
      Number(request.headers["content-length"] ?? 0) > 32 * 1024
    ) {
      response.writeHead(401).end();
      return;
    }
    let body = "";
    let size = 0;
    for await (const chunk of request) {
      size += Buffer.byteLength(chunk);
      if (size > 32 * 1024) {
        response.writeHead(413).end();
        return;
      }
      body += chunk;
    }
    try {
      const input = JSON.parse(body);
      const result = await agentBrowserCommand?.(input.command, input.value);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(result ?? { error: "browser is not ready" }));
    } catch (error) {
      response.writeHead(422).end(JSON.stringify({ error: String(error?.message ?? error) }));
    }
    return;
  }
  response.writeHead(404).end("Intrica desktop bridge endpoint not found");
});
app.setName("Intrica");
app.setAppUserModelId("com.intrica.desktop");

// Linux packages built without root cannot preserve Electron's setuid sandbox
// helper (chrome-sandbox must be root-owned and mode 4755). Keep the packaged
// app launchable for ordinary users, while retaining the Chromium sandbox on
// installations whose package manager preserved the helper correctly.
if (process.platform === "linux" && app.isPackaged) {
  const helper = resolve(dirname(process.execPath), "chrome-sandbox");
  try {
    const mode = statSync(helper);
    if (mode.uid !== 0 || (mode.mode & 0o4000) === 0) {
      console.warn("[intrica] chrome-sandbox is not root-owned SUID; using --no-sandbox");
      app.commandLine.appendSwitch("no-sandbox");
    }
  } catch {
    console.warn("[intrica] chrome-sandbox is unavailable; using --no-sandbox");
    app.commandLine.appendSwitch("no-sandbox");
  }
}
async function start() {
  await app.whenReady();
  if (process.platform === "darwin" && app.dock)
    app.dock.setIcon(resolve(directory, "assets/icon.png"));
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 800,
    minHeight: 600,
    title: "Intrica",
    backgroundColor: "#f6eddc",
    icon: resolve(directory, "assets/icon.png"),
    webPreferences: {
      preload: resolve(directory, "preload.cjs"),
      partition: "persist:intrica-app",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow = window;
  let language = "system";
  const languagePath = resolve(app.getPath("userData"), "language.json");
  try {
    language = JSON.parse(readFileSync(languagePath, "utf8"));
  } catch {}
  const languageCode = () =>
    language === "system" ? (/^zh/i.test(app.getLocale()) ? "zh-CN" : "en") : language;
  const nativeStrings = JSON.parse(
    readFileSync(resolve(directory, "assets/native-text.json"), "utf8"),
  );
  const nativeText = (key) => (languageCode() === "zh-CN" ? key : (nativeStrings[key] ?? key));
  nativeMessage = nativeText;
  ipcMain.handle("preferences:language", (event, value) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !event.senderFrame.url.startsWith("intrica://app/") ||
      !["system", "en", "zh-CN"].includes(value)
    )
      throw new Error("Invalid preference request");
    language = value;
    writeFileSync(languagePath, JSON.stringify(value), { mode: 0o600 });
  });
  await window.loadFile(resolve(directory, "assets/startup.html"));
  await window.webContents.executeJavaScript(
    `document.documentElement.lang=${JSON.stringify(languageCode())};document.querySelector("h1").textContent=${JSON.stringify(nativeText("正在启动 Intrica"))};document.querySelector("p").textContent=${JSON.stringify(nativeText("正在准备本地工作区…"))};`,
  );
  process.env.INTRICA_WORKSPACE_DIR ??= app.isPackaged ? homedir() : resolve(directory, "../..");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(process.env.INTRICA_DESKTOP_PORT ?? 0), "127.0.0.1", resolve);
  });
  process.env.INTRICA_BROWSER_PORT = String(server.address().port);
  process.env.INTRICA_BROWSER_TOKEN = browserToken;
  backend = await startLocalBackend({
    userData: app.getPath("userData"),
    schemaFile: app.isPackaged
      ? resolve(process.resourcesPath, "db/schema.sql")
      : resolve(directory, "../../db/schema.sql"),

    webRoot: app.isPackaged
      ? resolve(process.resourcesPath, "renderer")
      : resolve(directory, "../web/dist"),
  });
  if (quitting || window.isDestroyed()) return;
  apiUrl = backend ? new URL(backend.apiUrl) : undefined;
  const webRoot = app.isPackaged
    ? resolve(process.resourcesPath, "renderer")
    : resolve(directory, "../web/dist");
  connections = await createConnections({
    userData: app.getPath("userData"),
    safeStorage,
    localUrl: apiUrl?.origin,
    localToken: backend?.authToken,
    resolveSsh: (alias, target) => sshManager.target(alias, target),
    releaseSsh: (alias) => sshManager.release(alias),
  });
  sshManager = createSshManager({
    version: JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8")).version,
    userData: app.getPath("userData"),
    activateManaged: async (id) => {
      const state = await connections.activate(id);
      if (!window.isDestroyed()) window.webContents.send("connection:changed", state);
    },
    engine: await import(
      pathToFileURL(
        app.isPackaged
          ? resolve(process.resourcesPath, "deployment/deploy-server.mjs")
          : resolve(directory, "../../scripts/deploy-server.mjs"),
      ).href
    ),
    saveManaged: (input) => connections.saveManaged(input),
  });
  if (backend) {
    try {
      await connections.activate("local");
    } catch (error) {
      console.error("[local-connection]", error.message);
    }
  }
  if (process.env.INTRICA_SERVER_URL) {
    try {
      const baseUrl = serverOrigin(process.env.INTRICA_SERVER_URL);
      const existing = connections
        .list()
        .find((profile) => !profile.local && profile.baseUrl === baseUrl);
      const remote = await connections.save({
        ...(existing ? { id: existing.id } : {}),
        label: existing?.label ?? "Remote",
        baseUrl,
        ...(process.env.INTRICA_ACCESS_TOKEN !== undefined
          ? { token: process.env.INTRICA_ACCESS_TOKEN }
          : existing
            ? {}
            : { token: "" }),
      });
      await connections.activate(remote.id);
    } catch (error) {
      console.error("[remote-connection]", error.message);
    }
  }
  registerAppProtocol(session.fromPartition("persist:intrica-app"), webRoot, connections);
  updater = await createUpdater({
    build,
    userData: app.getPath("userData"),
    version: JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8")).version,
    packaged: app.isPackaged,
    shell,
  });
  for (const method of [
    "state",
    "check",
    "download",
    "cancel",
    "open",
    "configure",
    "dismissNotice",
  ]) {
    ipcMain.handle(`updates:${method}`, async (event, input) => {
      if (
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        !event.senderFrame.url.startsWith("intrica://app/")
      )
        throw new Error("Unknown renderer");
      return updater[method](input);
    });
  }
  updater.start();
  const files = createFileDownloads(
    connections,
    async (name) => {
      const result = await dialog.showSaveDialog(window, { defaultPath: name });
      return result.canceled ? null : result.filePath;
    },
    (path) => shell.showItemInFolder(path),
  );
  for (const method of ["save", "cancel", "state", "reveal"]) {
    ipcMain.handle(`files:${method}`, async (event, input) => {
      if (
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        !event.senderFrame.url.startsWith("intrica://app/")
      )
        throw new Error("Unknown renderer");
      return files[method](input);
    });
  }
  window.on("closed", () => files.close());
  for (const method of [
    "get",
    "list",
    "save",
    "activate",
    "disconnect",
    "remove",
    "inspect",
    "forgetToken",
  ]) {
    ipcMain.handle(`connection:${method}`, async (event, input) => {
      if (
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        !event.senderFrame.url.startsWith("intrica://app/")
      )
        throw new Error("Unknown renderer");
      return connections[method](input);
    });
  }
  for (const method of ["aliases", "connect", "inspect", "install", "state", "cancel", "restart"]) {
    ipcMain.handle(`ssh:${method}`, async (event, input) => {
      if (
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        !event.senderFrame.url.startsWith("intrica://app/")
      )
        throw new Error("Unknown renderer");
      return sshManager[method](input);
    });
  }
  const origin = "intrica://app";
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${origin}/`)) {
      event.preventDefault();
      if (validUrl(url)) void shell.openExternal(url);
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (validUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const browserSession = session.fromPartition("persist:intrica-browser");
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  const previews = createWebPreview(browserSession);
  let previewRevision = 0;
  let view;
  let desiredBounds;
  let attached = false;
  let suspended = false;
  let error = "";
  const state = () => ({
    url: view?.webContents.getURL() ?? "",
    title: view?.webContents.getTitle() ?? "",
    loading: view?.webContents.isLoading() ?? false,
    error,
    canGoBack: view?.webContents.navigationHistory.canGoBack() ?? false,
    canGoForward: view?.webContents.navigationHistory.canGoForward() ?? false,
    previewRevision,
  });
  const publish = () => {
    if (!window.isDestroyed()) window.webContents.send("browser:state", state());
  };
  const refreshPreviews = () => {
    previewRevision++;
    publish();
  };
  // Publish after Electron finishes the native focus transition.
  window.webContents.on("focus", () => setImmediate(refreshPreviews));
  function place() {
    if (!view || window.isDestroyed()) return;
    const visible =
      !suspended && desiredBounds && desiredBounds.width > 0 && desiredBounds.height > 0;
    if (!visible) {
      if (attached) window.contentView.removeChildView(view);
      attached = false;
      return;
    }
    const [width, height] = window.getContentSize();
    const x = Math.max(0, Math.min(width, Math.round(desiredBounds.x)));
    const y = Math.max(0, Math.min(height, Math.round(desiredBounds.y)));
    if (!attached) window.contentView.addChildView(view);
    attached = true;
    view.setBounds({
      x,
      y,
      width: Math.max(0, Math.min(width - x, Math.round(desiredBounds.width))),
      height: Math.max(0, Math.min(height - y, Math.round(desiredBounds.height))),
    });
  }
  function ensureView() {
    if (view) return view;
    view = new WebContentsView({
      webPreferences: {
        session: browserSession,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    // Snapshot loads do not emit these events on the visible view, avoiding
    // refresh loops on sites that rotate cookies on every request.
    for (const event of ["did-stop-loading", "did-navigate-in-page"])
      view.webContents.on(event, refreshPreviews);
    for (const eventName of ["will-navigate", "will-redirect"]) {
      view.webContents.on(eventName, (event, url) => {
        if (!validUrl(url)) event.preventDefault();
      });
    }
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (validUrl(url)) void navigate(url);
      return { action: "deny" };
    });
    for (const event of [
      "did-start-loading",
      "did-stop-loading",
      "did-navigate",
      "did-navigate-in-page",
      "page-title-updated",
    ])
      view.webContents.on(event, publish);
    view.webContents.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) {
        error = description;
        publish();
      }
    });
    place();
    return view;
  }
  function validUrl(value) {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }
  async function navigate(url) {
    if (!validUrl(url)) throw new Error("请输入 HTTP 或 HTTPS 网页地址");
    error = "";
    const browser = ensureView();
    try {
      await browser.webContents.loadURL(url);
    } catch {
      // did-fail-load reports real failures; stopping or superseding navigation is not an error.
    }
    publish();
  }
  agentBrowserCommand = async (command, value) => {
    if (command === "suspend") {
      suspended = Boolean(value);
      place();
    } else if (command === "bounds") {
      if (
        value !== null &&
        !["x", "y", "width", "height"].every((key) => Number.isFinite(value?.[key]))
      )
        throw new Error("Invalid bounds");
      desiredBounds = value;
      place();
    } else if (command === "navigate") await navigate(value);
    else if (command === "back" && view?.webContents.navigationHistory.canGoBack())
      view.webContents.navigationHistory.goBack();
    else if (command === "forward" && view?.webContents.navigationHistory.canGoForward())
      view.webContents.navigationHistory.goForward();
    else if (command === "reload") {
      error = "";
      view?.webContents.reload();
    } else if (command === "stop") view?.webContents.stop();
    else if (command === "click") {
      if (typeof value !== "string" || value.length > 500) throw new Error("Invalid selector");
      await view?.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(value)})?.click()`,
      );
    } else if (command === "type") {
      const selector = value?.selector;
      const text = value?.text;
      if (
        typeof selector !== "string" ||
        typeof text !== "string" ||
        selector.length > 500 ||
        text.length > 8000
      )
        throw new Error("Invalid browser input");
      await view?.webContents.executeJavaScript(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error("element not found");e.focus();e.value=${JSON.stringify(text)};e.dispatchEvent(new Event("input",{bubbles:true}));})()`,
      );
    } else if (command === "read") {
      const text = await view?.webContents.executeJavaScript(
        "document.body?.innerText?.slice(0,24000) ?? ''",
      );
      return { ...state(), text };
    }
    return state();
  };
  ipcMain.handle("browser:preview", async (event, url) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      throw new Error("Unknown renderer");
    return previews.capture(url, previewRevision);
  });
  window.on("closed", () => previews.close());
  ipcMain.handle("browser:command", async (event, command, value) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      throw new Error("Unknown renderer");
    return agentBrowserCommand(command, value);
  });
  window.on("resize", place);
  window.on("closed", () => {
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
    mainWindow = undefined;
  });
  await window.loadURL("intrica://app/");
}
// Closing the window, Cmd/Ctrl+Q and process signals use the same shutdown path.
app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void (async () => {
    await startup?.catch(() => {});
    await updater?.dispose();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    sshManager?.cancel(sshManager.state().operation?.id);
    await sshManager?.settle();
    connections?.close();
    sshManager?.close();
    await backend?.close();
  })()
    .catch((error) => console.error("[intrica:shutdown]", error))
    .finally(() => {
      shutdownComplete = true;
      app.quit();
    });
});
app.on("window-all-closed", () => app.quit());
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => app.quit());

if (!app.requestSingleInstanceLock()) {
  shutdownComplete = true;
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  startup = start();
  void startup.catch(async (error) => {
    console.error(error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      const message = String(error?.message ?? error)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;");
      await mainWindow.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(`<main style="font:14px system-ui;padding:48px;color:#51473e"><h1>${nativeMessage("Intrica 无法启动")}</h1><p>${message}</p><p>${nativeMessage("请关闭窗口后重试。")}</p></main>`)}`,
      );
    }
  });
}
