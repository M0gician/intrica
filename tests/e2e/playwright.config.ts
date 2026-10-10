import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { API_PORT, DATABASE_URL, UI_PORT } from "./environment.mjs";

const apiDataDir = mkdtempSync(join(tmpdir(), "intrica-e2e-api-"));

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${UI_PORT}`,
    trace: "retain-on-failure",
    locale: "zh-CN",
    extraHTTPHeaders: { Authorization: "Bearer intrica-e2e-token" },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // api-server.mjs：先跑 pretest（构建 api 链 + 重置 intrica_e2e），再以独立进程组拉起 API
      command: "node tests/e2e/api-server.mjs",
      cwd: "../..",
      url: `http://127.0.0.1:${API_PORT}/api/v2/health`,
      env: {
        PORT: String(API_PORT),
        HOST: "127.0.0.1",
        DATABASE_URL,
        DATA_DIR: apiDataDir,
        INTRICA_HOME: apiDataDir,
        INTRICA_WORKER: "true",
        INTRICA_ACCESS_TOKEN: "intrica-e2e-token",
      },
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10000 },
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // web-server.mjs：以独立进程组拉起 vite；INTRICA_API_PORT 注入 vite proxy 目标
      command: "node tests/e2e/web-server.mjs",
      cwd: "../..",
      url: `http://127.0.0.1:${UI_PORT}`,
      env: {
        INTRICA_API_PORT: String(API_PORT),
      },
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10000 },
      timeout: 120_000,
    },
  ],
});
