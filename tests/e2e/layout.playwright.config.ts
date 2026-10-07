import { defineConfig, devices } from "@playwright/test";

// CSS geometry checks use source files directly and require no build or backend.
export default defineConfig({
  testDir: ".",
  testMatch: "control-geometry.spec.ts",
  timeout: 30_000,
  workers: 1,
  reporter: [["list"]],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
