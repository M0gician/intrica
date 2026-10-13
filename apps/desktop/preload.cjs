const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("intricaDesktop", {
  files: {
    save: (input) => ipcRenderer.invoke("files:save", input),
    cancel: (id) => ipcRenderer.invoke("files:cancel", id),
    state: (id) => ipcRenderer.invoke("files:state", id),
    reveal: (id) => ipcRenderer.invoke("files:reveal", id),
  },
  connection: {
    subscribe: (listener) => {
      const changed = (_event, state) => listener(state);
      ipcRenderer.on("connection:changed", changed);
      return () => ipcRenderer.removeListener("connection:changed", changed);
    },
    get: () => ipcRenderer.invoke("connection:get"),
    list: () => ipcRenderer.invoke("connection:list"),
    save: (input) => ipcRenderer.invoke("connection:save", input),
    activate: (id) => ipcRenderer.invoke("connection:activate", id),
    disconnect: (id) => ipcRenderer.invoke("connection:disconnect", id),
    remove: (id) => ipcRenderer.invoke("connection:remove", id),
    inspect: (id) => ipcRenderer.invoke("connection:inspect", id),
    forgetToken: (id) => ipcRenderer.invoke("connection:forgetToken", id),
  },
  ssh: Object.fromEntries(
    ["aliases", "connect", "inspect", "install", "state", "cancel", "restart"].map((method) => [
      method,
      (input) => ipcRenderer.invoke(`ssh:${method}`, input),
    ]),
  ),
  preferences: { setLanguage: (value) => ipcRenderer.invoke("preferences:language", value) },
  updates: Object.fromEntries(
    ["state", "check", "download", "cancel", "open", "install", "configure", "dismissNotice"].map(
      (method) => [method, (value) => ipcRenderer.invoke(`updates:${method}`, value)],
    ),
  ),
  browser: {
    preview: (url) => ipcRenderer.invoke("browser:preview", url),
    command: (name, value) => ipcRenderer.invoke("browser:command", name, value),
    subscribe: (listener) => {
      const update = (_event, state) => listener(state);
      ipcRenderer.on("browser:state", update);
      return () => ipcRenderer.removeListener("browser:state", update);
    },
  },
});
