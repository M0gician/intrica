import { expect, it, vi } from "vitest";
import type { Sql } from "../../../adapters/postgres/database.js";
import { grantsFor } from "../../access/policy.js";
import { readObservationReader } from "./read-access.js";

vi.mock("../../../adapters/host/capabilities.js", () => ({
  hostCapabilities: async () => ({ skills: [{ path: "/skills/current" }] }),
}));
vi.mock("../../../adapters/host/sandbox.js", () => ({
  canonicalPath: async (path: string) => (path === "/alias" ? "/changed" : path),
}));
vi.mock("../../access/policy.js", () => ({ grantsFor: vi.fn() }));

it("hides revoked nodes and paths while preserving the exact current host path policy", async () => {
  const sql = {
    query: vi.fn().mockResolvedValue({ rows: [{ agent_id: "agent", canvas_id: "canvas" }] }),
  } as unknown as Sql;
  vi.mocked(grantsFor).mockResolvedValue([{ resource_id: "allowed" }] as never);
  const host = {
    assertPath: vi.fn(async (_actor, path) => {
      if (path === "/revoked") throw new Error("FORBIDDEN");
    }),
  };
  const reader = await readObservationReader(sql, "conversation", host);
  expect(await reader({ kind: "node", nodeId: "allowed" })).toBe(true);
  expect(await reader({ kind: "node", nodeId: "revoked" })).toBe(false);
  expect(await reader({ kind: "path", path: "/scratch/file" })).toBe(true);
  expect(host.assertPath).toHaveBeenCalledWith({ agentId: "agent" }, "/scratch/file", false, sql);
  expect(await reader({ kind: "path", path: "/revoked" })).toBe(false);
  expect(await reader({ kind: "path", path: "/alias" })).toBe(false);
  expect(
    await (await readObservationReader(sql, "conversation"))({
      kind: "path",
      path: "/scratch/file",
    }),
  ).toBe(false);
});

it("checks the live skill index and allows the workspace owner to inspect its own history", async () => {
  const sql = {
    query: vi.fn().mockResolvedValue({ rows: [{ agent_id: null, canvas_id: "canvas" }] }),
  } as unknown as Sql;
  const reader = await readObservationReader(sql, "conversation");
  expect(await reader({ kind: "path", path: "/previously-read" })).toBe(true);
  expect(await reader({ kind: "skill", skillId: "/skills/current" })).toBe(true);
  expect(await reader({ kind: "skill", skillId: "/skills/removed" })).toBe(false);
  const missing = await readObservationReader(
    { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Sql,
    "gone",
  );
  expect(await missing({ kind: "node", nodeId: "allowed" })).toBe(false);
});
