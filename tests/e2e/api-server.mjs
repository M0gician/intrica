import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDefaultEndpoint } from "../fixtures/default-endpoint.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// 1. 构建 Server 运行链并重置 intrica_e2e（同步执行，失败即非零退出）
execSync("node tests/e2e/pretest-e2e.mjs", { cwd: repoRoot, stdio: "inherit" });

// 2. 以独立进程组拉起 API；本进程退出或被终止时杀整个进程组，
//    避免 playwright 只杀直接子进程导致 server 残留占用端口
const endpoint = await createDefaultEndpoint();
const child = spawn(process.execPath, ["apps/server/dist/server.js"], {
  cwd: repoRoot,
  env: { ...process.env, ...endpoint.env },
  stdio: "inherit",
  detached: true,
});

let stopping = false;
function stopTree() {
  if (stopping) return;
  stopping = true;
  endpoint.close();
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
