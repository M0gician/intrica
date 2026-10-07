import { BrowserWindow } from "electron";

/** Bounded snapshots share the browser's web session, never the app origin. */
export function createWebPreview(browserSession) {
  const inFlight = new Map();
  let active = 0;
  let closed = false;
  const queue = [];
  const windows = new Set();
  async function capture(value, revision = 0) {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
      throw new Error("只支持 HTTP(S) 网页快照");
    const key = `${revision}:${url.href}`;
    const existing = inFlight.get(key);
    if (existing) return existing;
    if (queue.length >= 8) throw new Error("快照队列已满");
    const promise = (async () => {
      if (active >= 2) await new Promise((resolve) => queue.push(resolve));
      else active++;
      let window;
      let timer;
      try {
        if (closed) throw new Error("快照服务已关闭");
        window = new BrowserWindow({
          show: false,
          width: 1200,
          height: 800,
          webPreferences: {
            offscreen: true,
            session: browserSession,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
          },
        });
        windows.add(window);
        const contents = window.webContents;
        contents.setWindowOpenHandler(() => ({ action: "deny" }));
        for (const name of ["will-navigate", "will-redirect"])
          contents.on(name, (event, target) => {
            if (!/^https?:\/\//i.test(target)) event.preventDefault();
          });
        const work = (async () => {
          await contents.loadURL(url.href);
          await new Promise((resolve) => setTimeout(resolve, 700));
          const image = await contents.capturePage();
          if (image.isEmpty()) throw new Error("网页尚未绘制");
          return {
            url: url.href,
            title: contents.getTitle(),
            dataUrl: `data:image/jpeg;base64,${image.resize({ width: 600 }).toJPEG(75).toString("base64")}`,
          };
        })();
        return await Promise.race([
          work,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("网页快照超时")), 10000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        if (window) {
          windows.delete(window);
          if (!window.isDestroyed()) window.destroy();
        }
        const next = queue.shift();
        if (next) next();
        else active--;
      }
    })();
    // Coalesce concurrent requests only. Login/logout can change a page without
    // changing its URL, so completed images must not outlive the web session state.
    inFlight.set(key, promise);
    const forget = () => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    };
    void promise.then(forget, forget);
    return promise;
  }
  return {
    capture,
    close: () => {
      closed = true;
      for (const window of windows) window.destroy();
      inFlight.clear();
    },
  };
}
