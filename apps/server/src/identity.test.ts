import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadServerIdentity } from "./identity.js";

it("creates an identity once and preserves corrupt or unreadable identity files", () => {
  const directory = mkdtempSync(join(tmpdir(), "intrica-identity-"));
  const path = join(directory, "server.json");
  try {
    const original = loadServerIdentity(directory);
    expect(loadServerIdentity(directory)).toEqual(original);
    for (const source of ["{", "null", "{}", '{"id":"existing"}']) {
      writeFileSync(path, source);
      expect(() => loadServerIdentity(directory)).toThrow();
      expect(readFileSync(path, "utf8")).toBe(source);
    }
    rmSync(path);
    mkdirSync(path);
    expect(() => loadServerIdentity(directory)).toThrow("EISDIR");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
