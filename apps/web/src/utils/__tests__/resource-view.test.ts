import { describe, expect, it } from "vitest";
import { SceneProjection } from "../../features/canvas/scene";
import { makeNode } from "../../test/factories";
import { nodeBookmark, presentNode } from "../resource-view";

it("Agent 容器按直接空间成员投影，管理关系不影响容器宽度和缓存", () => {
  const container = makeNode({ id: "container", kind: "agent" });
  const child = makeNode({ id: "child", kind: "agent", parentId: container.id });
  const managed = makeNode({ id: "managed", kind: "agent", managerId: container.id });
  const text = makeNode({ id: "text", parentId: container.id });
  const all = [container, child, managed, text];
  const nodes = new Map(all.map((node) => [node.id, node]));
  const projection = new SceneProjection();
  const before = projection.project(nodes, new Map());
  expect(before.teams.get(container.id)).toEqual([child]);
  expect(before.nodes.get(container.id)).toEqual(presentNode(container, new Map(), all));
  expect(before.nodes.get(container.id)!.position.width).toBeGreaterThan(container.position.width);
  expect(projection.project(nodes, new Map()).nodes.get(container.id)).toBe(
    before.nodes.get(container.id),
  );
  nodes.set(child.id, { ...child, parentId: "root" });
  const after = projection.project(nodes, new Map());
  expect(after.teams.get(container.id)).toBeUndefined();
  expect(after.nodes.get(container.id)!.position.width).toBe(container.position.width);
  // Counterfactual: manager-only membership would still display an external Agent here.
  expect([...nodes.values()].filter((node) => node.managerId === container.id)).toEqual([managed]);
});

describe("网页书签识别", () => {
  it("识别独立网址、明确 Markdown 链接和短标题与网址", () => {
    for (const text of [
      "https://example.com/guide",
      "[指南](https://example.com/guide)",
      "指南\nhttps://example.com/guide",
    ])
      expect(nodeBookmark(makeNode({ id: "link", title: "网页链接", text }))?.url).toBe(
        "https://example.com/guide",
      );
  });
  it("来源摘录、多链接和正文中的链接保持文字", () => {
    for (const text of [
      "摘录\n\n来源：https://example.com",
      "摘录\n来源：https://example.com",
      "https://example.com\nhttps://example.org",
      "阅读 https://example.com 获取资料",
      "https://example.com 含有正文",
    ])
      expect(nodeBookmark(makeNode({ id: "text", text }))).toBeNull();
  });
  it("拒绝危险协议和带账号的地址", () => {
    for (const text of ["javascript:alert(1)", "file:///tmp/a", "https://user:secret@example.com"])
      expect(nodeBookmark(makeNode({ id: "text", text }))).toBeNull();
  });
  it("本机文件、图片和待办的 URL 正文不会覆盖原类型", () => {
    for (const node of [
      makeNode({ id: "file", resource: { type: "file", path: "/tmp/link.txt" } }),
      makeNode({ id: "image", kind: "image" }),
      makeNode({ id: "todo", kind: "todo" }),
    ])
      expect(nodeBookmark({ ...node, text: "https://example.com" })).toBeNull();
  });
});
