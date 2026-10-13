import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DomainError } from "../postgres/database.js";
import { canonicalPath } from "./sandbox.js";

/** Owner navigation roots; never use the canvas root as an Agent's execution grant. */
export async function canvasWorkspacePaths(dataDir: string, canvasId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(canvasId)) throw new DomainError("VALIDATION", "画布标识无效");
  const root = join(dataDir, "workspaces", canvasId);
  await mkdir(join(root, "shared"), { recursive: true, mode: 0o700 });
  const canvasRoot = await canonicalPath(root);
  return {
    canvasRoot,
    sharedRoot: join(canvasRoot, "shared"),
    agentRoots: (await readdir(canvasRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && d.name !== "shared" && !d.name.startsWith("."))
      .map((d) => ({ agentId: d.name, path: join(canvasRoot, d.name) })),
  };
}
