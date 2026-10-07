import { afterEach, expect, it, vi } from "vitest";
import type { AppInstance } from "../app.js";
import type { ApiConfig } from "../config.js";
import { registerUpdates } from "./updates.js";

afterEach(() => vi.unstubAllEnvs());

it("reports full legacy preview provenance without inventing build time or leaking credentials", () => {
  vi.stubEnv("INTRICA_COMMIT", "0123456789ab+preview.abcdef012345");
  vi.stubEnv("INTRICA_RELEASE_VERSION", "0.2.5");
  vi.stubEnv("INTRICA_BUILD_ID", "");
  vi.stubEnv("INTRICA_CHANNEL", "");
  vi.stubEnv("INTRICA_BUILD_TIME", "");
  let version: (() => unknown) | undefined;
  const app = {
    get: (path: string, handler: (_request: unknown, reply: unknown) => unknown) => {
      if (path.endsWith("/version")) version = () => handler({}, { header: vi.fn() });
    },
  };
  registerUpdates(app as unknown as AppInstance, { deployment: "desktop" } as ApiConfig);
  const result = version!();
  expect(result).toMatchObject({
    version: "0.2.5",
    commit: "0123456789ab+preview.abcdef012345",
    build: {
      version: "0.2.5",
      buildId: "0123456789ab+preview.abcdef012345",
      channel: "preview",
      commit: "0123456789ab",
      builtAt: null,
    },
  });
  expect(JSON.stringify(result)).not.toContain("secret");
});
