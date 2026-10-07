import { describe, expect, it } from "vitest";
import { agentAncestors, managesNode } from "./agent-team.js";
import type { Node } from "./model.js";

const node = (
  id: string,
  kind: Node["kind"],
  parentId: string | null,
  role?: NonNullable<Node["agent"]>["role"],
): Node => ({
  id,
  canvasId: "root",
  layoutVersion: 0,
  sortKey: "0",
  contentLoaded: true,
  kind,
  parentId,
  ...(kind === "agent" ? { agent: { persona: "", role: role ?? "read", enabled: false } } : {}),
  position: { x: 0, y: 0, width: 100, height: 100 },
  childOrder: [],
  lifecycle: "user",
  origin: "user",
  createdAt: new Date(0).toISOString(),
  revision: 1,
});

describe("Agent Team scope", () => {
  it("uses direct Agent parentage without treating nested resources as team members", () => {
    const nodes = [
      node("team", "agent", "root", "admin"),
      node("member", "agent", "team", "write"),
      node("resource", "text", "member"),
    ];
    expect(managesNode(nodes, "team", "member")).toBe(true);
    expect(managesNode(nodes, "team", "resource")).toBe(false);
  });

  it("stops the management chain at ordinary containers", () => {
    const nodes = [
      node("team", "agent", "root", "admin"),
      node("member", "agent", "team", "write"),
      node("folder", "text", "member"),
      node("leaf", "agent", "folder", "read"),
    ];
    expect(agentAncestors(nodes, "leaf").map((item) => item.id)).toEqual([]);
    expect(agentAncestors(nodes, "member").map((item) => item.id)).toEqual(["team"]);
  });
});
