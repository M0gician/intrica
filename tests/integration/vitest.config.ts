import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts", "local-startup.test.mjs"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
