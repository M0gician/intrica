import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const rendererRoot = fileURLToPath(new URL("../../apps/web", import.meta.url));
const viteBin = fileURLToPath(
  new URL("../../apps/web/node_modules/vite/bin/vite.js", import.meta.url),
);

import { UI_PORT as uiPort } from "./environment.mjs";

// 以独立进程组拉起 vite；本进程退出或被终止时杀整个进程组
const child = spawn(
  process.execPath,
  [
    viteBin,
    ...(process.env.INTRICA_E2E_PREVIEW ? ["preview"] : []),
    "--host",
    "127.0.0.1",
    "--port",
    String(uiPort),
    "--strictPort",
  ],
  {
    cwd: rendererRoot,
    env: process.env,
    stdio: "inherit",
    detached: true,
  },
);

let stopping = false;
function stopTree() {
  if (stopping) return;
  stopping = true;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // 已退出则忽略
    }
  }
}

process.on("SIGTERM", () => {
  stopTree();
  process.exit(0);
});
process.on("SIGINT", () => {
  stopTree();
  process.exit(0);
});
process.on("exit", stopTree);
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal === null ? 0 : 1));
});
