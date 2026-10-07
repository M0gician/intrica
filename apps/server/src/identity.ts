import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ServerIdentity = { id: string; createdAt: string };

/** Stable identity is the only server-local state outside the graph database. */
export function loadServerIdentity(dataDir: string): ServerIdentity {
  const path = join(dataDir, "server.json");
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ServerIdentity>;
    if (typeof value.id === "string" && value.id.length > 0 && typeof value.createdAt === "string")
      return { id: value.id, createdAt: value.createdAt };
  } catch {
    // First boot or a partially written file: replace it with a fresh identity.
  }
  const identity = { id: randomUUID(), createdAt: new Date().toISOString() };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  return identity;
}
