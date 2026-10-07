import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ApiConfig } from "../config.js";
export async function superviseWorker(config: ApiConfig) {
  let stopping = false;
  let started = false;
  let child: ReturnType<typeof fork> | undefined;
  let restart: ReturnType<typeof setTimeout> | undefined;
  const launch = () =>
    new Promise<void>((resolve, reject) => {
      const current = fork(fileURLToPath(new URL("./worker.js", import.meta.url)), [], {
        execArgv: [],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      child = current;
      const timer = setTimeout(() => {
        current.kill("SIGKILL");
        reject(new Error("Worker 启动超时"));
      }, 15000);
      current.once("message", (message: any) => {
        if (message.type === "ready") {
          clearTimeout(timer);
          resolve();
        }
      });
      current.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      current.once("exit", (code) => {
        clearTimeout(timer);
        if (started && !stopping)
          restart = setTimeout(
            () => void launch().catch((error) => console.error("[worker:restart]", error.message)),
            1000,
          );
        reject(new Error(`Worker 在启动完成前退出 (${code})`));
      });
      current.send({ config });
    });
  const close = async () => {
    stopping = true;
    if (restart) clearTimeout(restart);
    const current = child;
    if (!current || current.exitCode !== null || current.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => current.kill("SIGKILL"), 12000);
      current.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      current.kill("SIGTERM");
    });
  };
  try {
    await launch();
    started = true;
  } catch (error) {
    await close();
    throw error;
  }
  return { close };
}
