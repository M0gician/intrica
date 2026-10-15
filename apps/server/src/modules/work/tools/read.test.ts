import { Value } from "typebox/value";
import { expect, it, vi } from "vitest";
import { type ExecutionTool, result } from "../../execution/tool-calls.js";
import type { ToolContext } from "./context.js";
import { readTools } from "./read.js";

function fixture(cursor?: object) {
  const query = vi.fn(async (sql: string, _parameters?: unknown[]) => ({
    rows: sql.includes("select c.agent_id")
      ? [{ agent_id: null, canvas_id: "canvas" }]
      : cursor
        ? [cursor]
        : [],
  }));
  const pathReader = {
    normalize: vi.fn(async (input) => input),
    prepare: vi.fn(async () => undefined),
    execute: vi.fn(async () =>
      result({
        path: "/fixture.txt",
        sourceVersion: "v1",
        text: "last\n",
        offset: 201,
        returnedLines: 1,
        state: "eof",
      }),
    ),
  } as unknown as ExecutionTool;
  const context = {
    text: (en: string) => en,
    registry: {
      graph: {
        db: {
          pool: { query },
          canvas: async (_canvas: string, action: (tx: object) => unknown) => action({ query }),
        },
      },
    },
    ctx: { run: { canvas_id: "canvas" } },
    input: { conversationId: "conversation" },
  } as unknown as ToolContext;
  const [open, next] = readTools(context, pathReader);
  return { open: open!, next: next!, pathReader, query };
}

it("separates opening and continuation schemas, without a legacy cursor execution alias", async () => {
  const { open, next } = fixture();
  expect(open.name).toBe("read");
  expect(next.name).toBe("read_next");
  expect(Value.Check(open.parameters, { path: "/fixture.txt", line: 1 })).toBe(true);
  expect(Value.Check(open.parameters, { cursor: "cursor" })).toBe(false);
  expect(Value.Check(next.parameters, { cursor: "cursor" })).toBe(true);
  expect(Value.Check(next.parameters, { cursor: "cursor", mode: "text" })).toBe(false);
  await expect(
    open.normalize!({ path: "/fixture.txt", characterOffset: 10 }),
  ).rejects.toMatchObject({ code: "READ_POSITION" });
  expect(
    await open.normalize!({ nodeId: "note", characterOffset: 6000, sourceVersion: "v2" }),
  ).toMatchObject({
    target: { kind: "node", nodeId: "note" },
    input: { offset: 6000 },
    sourceVersion: "v2",
  });
});

it("rechecks the original reader authorization and verifies the version before emitting a receipt", async () => {
  const { next, pathReader, query } = fixture({
    target: { kind: "path", path: "/fixture.txt" },
    input: { path: "/fixture.txt", position: { line: 201, column: 0 } },
    source_version: "v1",
    valid: true,
  });
  const args = await next.normalize!({ cursor: "cursor" });
  expect(query.mock.calls[0]![1]).toEqual(["cursor", "canvas", "conversation"]);
  await next.prepare!({} as never, "call", "logical", args);
  expect(pathReader.prepare).toHaveBeenCalledWith({}, "call", "logical", args.input);
  const output = await next.execute("logical", args, new AbortController().signal);
  expect(output.details.readObservation).toMatchObject({
    sourceKey: "path:/fixture.txt",
    sourceVersion: "v1",
    position: { line: 201, returnedChars: 5 },
    nextCursor: null,
  });
  await expect(
    next.execute("logical", { ...args, sourceVersion: "changed" }, new AbortController().signal),
  ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
});

it("expired cursors give read-compatible reopening arguments without granting access", async () => {
  const { open, next, pathReader } = fixture({
    target: { kind: "path", path: "/fixture.txt" },
    input: {
      path: "/fixture.txt",
      mode: "text",
      position: { line: 201, column: 37, targetLine: 1 },
    },
    source_version: "v1",
    valid: false,
  });
  let error: any;
  try {
    await next.normalize!({ cursor: "expired" });
  } catch (caught) {
    error = caught;
  }
  expect(error.code).toBe("READ_CURSOR_EXPIRED");
  expect(error.details.reopen).toEqual({
    path: "/fixture.txt",
    sourceVersion: "v1",
    mode: "text",
    line: 201,
  });
  expect(Value.Check(open.parameters, error.details.reopen)).toBe(true);
  expect(pathReader.execute).not.toHaveBeenCalled();
  const missing = fixture();
  await expect(missing.next.normalize!({ cursor: "other-conversation" })).rejects.toMatchObject({
    code: "READ_CURSOR_EXPIRED",
  });
});
