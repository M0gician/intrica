import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ServerIdentity = { id: string; createdAt: string };

/** Stable identity is the only server-local state outside the graph database. */
export function loadServerIdentity(dataDir: string): ServerIdentity {
  const path = join(dataDir, "server.json");
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const identity = { id: randomUUID(), createdAt: new Date().toISOString() };
    mkdirSync(dataDir, { recursive: true });
    try {
      writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      return identity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      source = readFileSync(path, "utf8");
    }
  }
  const value = JSON.parse(source) as Partial<ServerIdentity> | null;
  if (!value || typeof value.id !== "string" || !value.id || typeof value.createdAt !== "string")
    throw new Error("Invalid server identity; restore server.json from the original installation");
  return { id: value.id, createdAt: value.createdAt };
}
