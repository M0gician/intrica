import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Build-time only. Missing provenance stays unknown; timestamps are never inferred from commits. */
export function buildMetadata(packagePath) {
  const version = JSON.parse(readFileSync(packagePath, "utf8")).version;
  let commit = process.env.INTRICA_COMMIT ?? null;
  if (!commit) {
    try {
      commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {}
  }
  const builtAt = process.env.INTRICA_BUILD_TIME ?? new Date().toISOString();
  return {
    version,
    commit,
    builtAt,
    buildId:
      process.env.INTRICA_BUILD_ID ??
      (commit?.includes("preview.") ? commit : `${commit ?? "unknown"}+build.${builtAt}`),
    channel:
      process.env.INTRICA_CHANNEL ??
      (commit?.includes("preview.")
        ? "preview"
        : /^refs\/tags\/v\d+\.\d+\.\d+$/.test(process.env.GITHUB_REF ?? "")
          ? "stable"
          : "development"),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(process.argv[2], `${JSON.stringify(buildMetadata("package.json"), null, 2)}\n`);
}
