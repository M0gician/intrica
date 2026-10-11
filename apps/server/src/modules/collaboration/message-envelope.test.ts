import { messageEnvelopeSchema } from "@intrica/contracts";
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { toolInputError } from "../execution/tool-validation.js";
import {
  messageEnvelope,
  messageEnvelopeExample,
  messageEnvelopeIssues,
} from "./message-envelope.js";

it.each([
  "request",
  "followup",
  "agent",
  "agents",
  "resource_readers",
  "manager",
  "canvas",
  "internal",
])("authors one flat %s message and normalizes its routing", (to) => {
  const example = messageEnvelopeExample({ to });
  expect(Value.Check(messageEnvelopeSchema, example)).toBe(true);
  expect(messageEnvelopeIssues(example as any)).toEqual([]);
  expect(messageEnvelope(example)).toMatchObject({ target: { kind: to }, message: "message text" });
});

it.each([
  [{ to: "agent", message: "unchanged body" }, ["/id", "/kind"]],
  [{ to: "canvas", id: "wrong", kind: "update", message: "body" }, ["/id"]],
  [{ to: "agents", kind: "request", message: "body" }, ["/ids"]],
  [{ to: "internal", kind: "result", message: "private" }, ["/kind"]],
  [{ to: "followup", id: "req", kind: "result", message: "body" }, ["/kind"]],
  [{ to: "agent", id: "agent", kind: "decline", message: "body" }, ["/to"]],
  [
    { to: "request", id: "req", kind: "result", lifetime: "independent", message: "body" },
    ["/lifetime"],
  ],
])("returns actionable field errors without echoing message content", (input, paths) => {
  const issues = messageEnvelopeIssues(input as any);
  expect(issues.map((issue) => issue.path)).toEqual(paths);
  const error = toolInputError(
    "send_message",
    messageEnvelopeSchema,
    input,
    undefined,
    issues,
    messageEnvelopeExample(input),
  );
  expect(error).toMatchObject({ executed: false, code: "TOOL_ARGUMENTS_INVALID" });
  expect(JSON.stringify(error)).not.toContain(input.message);
  expect(messageEnvelopeIssues(error!.example as any)).toEqual([]);
  expect(() => messageEnvelope(input)).toThrow();
});

it("rejects nested and encoded routing, preserving a stable repair fingerprint", () => {
  for (const to of [
    { kind: "agent", agentId: "secret-ID" },
    JSON.stringify({ kind: "agent", agentId: "secret-ID" }),
  ]) {
    const error = toolInputError("send_message", messageEnvelopeSchema, {
      to,
      message: "secret-body",
    });
    expect(error?.issues.some((issue) => issue.path === "/to")).toBe(true);
    expect(JSON.stringify(error)).not.toContain("secret-ID");
    expect(JSON.stringify(error)).not.toContain("secret-body");
  }
});

it("duplicate addresses remain unambiguous and normalize to one recipient selection", () => {
  expect(
    messageEnvelope({
      to: "agents",
      ids: ["agent-a", "agent-a"],
      kind: "update",
      message: "progress",
    }),
  ).toMatchObject({ target: { kind: "agents", agentIds: ["agent-a"] } });
  expect(
    messageEnvelope({
      to: "resource_readers",
      ids: Array(50).fill("resource-a"),
      kind: "update",
      message: "progress",
    }),
  ).toMatchObject({ target: { kind: "resource_readers", resourceIds: ["resource-a"] } });
});

it("missing schema fields identify their exact path", () => {
  expect(
    toolInputError("send_message", messageEnvelopeSchema, { message: "fixture" })?.issues,
  ).toEqual([
    expect.objectContaining({
      path: "/to",
      actual: "undefined",
      message: "Supply the required to field.",
    }),
  ]);
});
