import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["benchmarks/**/*.bench.ts"], fileParallelism: false, hookTimeout: 120000 },
});
