import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { expect, it } from "vitest";
import { type ArchiveAccessScope, archiveScopeAllowed, mergeArchiveScopes } from "./access.js";
import {
  archiveReference,
  archiveSources,
  parseArchiveReference,
  sourcePage,
} from "./projection.js";

it("preserves exact source text and tool identifiers while excluding reasoning and binary media", () => {
  const messages = [
    { role: "user", content: "原始要求\n保留每个字符 😀", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.ts" } },
        { type: "text", text: `${"a".repeat(8000)}exact-evidence${"b".repeat(8000)}` },
      ],
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "call-1",
      isError: false,
      content: [
        { type: "text", text: "line 1\nline 2" },
        { type: "image", mimeType: "image/png", data: "private-base64" },
      ],
      timestamp: 3,
    },
  ] as AgentMessage[];
  const sources = archiveSources(messages);
  expect(sources[0]!.text).toBe(messages[0]!.content);
  expect(sources[1]!.text).toContain("exact-evidence");
  expect(sources[1]!.text).toContain('"toolCallId":"call-1"');
  expect(sources[2]).toMatchObject({
    logicalToolCallId: "call-1",
    toolName: "read",
    isError: false,
  });
  expect(JSON.stringify(sources)).not.toContain("private reasoning");
  expect(JSON.stringify(sources)).not.toContain("private-base64");
});

it("paginates exact text, including Unicode pairs and one-position budgets, without gaps", () => {
  const [source] = archiveSources([
    { role: "user", content: "a😀汉𠮷z".repeat(2000), timestamp: 0 },
  ]);
  for (const limit of [1, 3, 6000]) {
    let offset = 0,
      text = "",
      pages = 0;
    for (;;) {
      const page = sourcePage(source!, offset, limit);
      expect(page.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      text += page.text;
      pages++;
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(text).toBe(source!.text);
    expect(pages).toBeGreaterThan(1);
  }
  expect(() => sourcePage(source!, 2)).toThrow("nextOffset");
});

it("keeps references stable and rejects malformed or unbounded indices", () => {
  expect(parseArchiveReference(archiveReference("summary-1", 10))).toEqual({
    id: "summary-1",
    source: 10,
  });
  expect(parseArchiveReference("context:summary-1:summary")).toEqual({
    id: "summary-1",
    source: "summary",
  });
  for (const ref of [
    "summary-1",
    "context:summary-1:-1",
    "context:summary-1:9999999999",
    "context:a:01",
  ])
    expect(() => parseArchiveReference(ref)).toThrow("ref");
});

it("retains inherited access requirements and denies missing, revoked or formerly host scopes", async () => {
  const first: ArchiveAccessScope = {
    version: 1,
    ownerOnly: false,
    hostExecution: false,
    resources: [{ id: "source-a" }],
  };
  const second: ArchiveAccessScope = {
    version: 1,
    ownerOnly: false,
    hostExecution: false,
    resources: [{ id: "source-b" }],
  };
  const merged = mergeArchiveScopes([first, second, first]);
  expect(merged.resources).toHaveLength(2);
  const grants = [{ resource_id: "source-a" }, { resource_id: "source-b" }] as any;
  expect(await archiveScopeAllowed(merged, grants, false)).toBe(true);
  expect(await archiveScopeAllowed(merged, grants.slice(1), true)).toBe(false);
  expect(await archiveScopeAllowed({ ...merged, hostExecution: true }, grants, false)).toBe(false);
  expect(await archiveScopeAllowed({ ...merged, ownerOnly: true }, grants, true)).toBe(false);
  expect(await archiveScopeAllowed(null, grants, true)).toBe(false);
});
