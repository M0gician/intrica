import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  type BuildIdentity,
  describeBuild,
  type ServerVersion,
  type UpdateCheck,
} from "@intrica/contracts";
import { checkRelease, UpdateError } from "@intrica/releases";
import { DomainError } from "../adapters/postgres/database.js";
import type { AppInstance } from "../app.js";
import type { ApiConfig } from "../config.js";

export const serverVersion = () =>
  process.env.INTRICA_RELEASE_VERSION ??
  (createRequire(import.meta.url)("../../package.json").version as string);
export function registerUpdates(app: AppInstance, config: ApiConfig) {
  const version = serverVersion();
  let metadata: Partial<BuildIdentity> = {};
  try {
    metadata = JSON.parse(readFileSync(new URL("../build.json", import.meta.url), "utf8"));
  } catch {}
  const build = describeBuild({
    ...(process.env.INTRICA_COMMIT && process.env.INTRICA_COMMIT !== metadata.commit
      ? { commit: process.env.INTRICA_COMMIT, buildId: process.env.INTRICA_COMMIT }
      : metadata),
    version,
    ...(process.env.INTRICA_BUILD_ID ? { buildId: process.env.INTRICA_BUILD_ID } : {}),
    ...(process.env.INTRICA_CHANNEL ? { channel: process.env.INTRICA_CHANNEL } : {}),
    ...(process.env.INTRICA_BUILD_TIME ? { builtAt: process.env.INTRICA_BUILD_TIME } : {}),
  });
  let cached: UpdateCheck | undefined, pending: Promise<UpdateCheck> | undefined;
  app.get("/api/v2/settings/version", (_request, reply): ServerVersion => {
    reply.header("Cache-Control", "no-store");
    return {
      version,
      build,
      apiVersion: "v2",
      schemaVersion: 10,
      deployment: config.deployment,
      commit: process.env.INTRICA_COMMIT ?? metadata.commit ?? null,
    };
  });
  app.get("/api/v2/settings/updates", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (cached && Date.now() - Date.parse(cached.checkedAt) < 60_000) return cached;
    try {
      pending ??= checkRelease(version)
        .then((value) => (cached = value))
        .finally(() => {
          pending = undefined;
        });
      return await pending;
    } catch (error) {
      throw new DomainError(
        error instanceof UpdateError ? error.code : "UPDATE_UNAVAILABLE",
        "Unable to check updates",
      );
    }
  });
}
