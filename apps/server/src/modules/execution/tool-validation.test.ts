import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { toolInputError } from "./tool-validation.js";

describe("structured tool input errors", () => {
  it("identifies nested types without parsing arbitrary strings or echoing their contents", () => {
    const schema = Type.Object({
      target: Type.Object({ kind: Type.Literal("node"), id: Type.String() }),
    });
    const error = toolInputError("inspect", schema, { target: '{"secret":"private input"}' })!;
    expect(error).toMatchObject({
      code: "TOOL_ARGUMENTS_INVALID",
      phase: "validation",
      executed: false,
      issues: [{ path: "/target", expected: "object", actual: "string" }],
    });
    expect(JSON.stringify(error)).not.toContain("private input");
    expect(Value.Check(schema, error.example)).toBe(true);
  });
  it("groups the same schema error across different argument values and distinguishes other fields", () => {
    const schema = Type.Object({ count: Type.Integer(), items: Type.Array(Type.String()) });
    const first = toolInputError("batch", schema, { count: "one", items: [] })!;
    expect(toolInputError("batch", schema, { count: "two", items: [] })?.fingerprint).toBe(
      first.fingerprint,
    );
    expect(toolInputError("batch", schema, { count: 2, items: "two" })?.fingerprint).not.toBe(
      first.fingerprint,
    );
    expect(toolInputError("batch", schema, { count: 2, items: [] })).toBeNull();
  });
  it("separates parse failure and unavailable definitions from execution", () => {
    expect(toolInputError("read", {}, {}, "Incomplete JSON")?.phase).toBe("parse");
    expect(toolInputError("missing", undefined, undefined)).toMatchObject({
      code: "TOOL_UNKNOWN",
      executed: false,
    });
  });
  it("selects nested discriminated examples from the relevant contract branch", () => {
    const schema = Type.Union([
      Type.Object({
        target: Type.Object({ kind: Type.Literal("internal") }),
        message: Type.String(),
      }),
      Type.Object({
        target: Type.Object({ kind: Type.Literal("agent"), id: Type.String() }),
        kind: Type.Literal("request"),
        message: Type.String(),
      }),
    ]);
    const error = toolInputError("send", schema, {
      target: { kind: "agent", id: 123 },
      kind: "request",
      message: "task",
    })!;
    expect(error.example).toMatchObject({
      target: { kind: "agent", id: expect.any(String) },
      kind: "request",
    });
    expect(Value.Check(schema, error.example)).toBe(true);
  });
});
