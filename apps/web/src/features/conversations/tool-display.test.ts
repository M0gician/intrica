import { expect, it } from "vitest";
import {
  boundedToolText,
  coalesceToolEvents,
  parsedToolOutput,
  readableToolOutput,
  toolLabel,
  toolOutcomeLabel,
} from "./tool-display";

const result = (value: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  isError,
});

it("labels access tools and uses actual returned status, not the requested decision", () => {
  expect(toolLabel("review_access_request")).toBe("审查权限申请");
  expect(toolLabel("list_access_requests")).toBe("查看权限申请");
  const data = {
    name: "review_access_request",
    status: "complete",
    args: { decision: "escalate" },
    result: result({ status: "pending" }),
  };
  expect(toolOutcomeLabel(data)).toBe("已转交 · 仍待审批");
  expect(toolOutcomeLabel({ ...data, args: { decision: "approve" } })).toBe("仍待审批");
  expect(toolOutcomeLabel({ ...data, result: result({ status: "approved" }) })).toBe("已批准");
  expect(toolOutcomeLabel({ ...data, result: result({ status: "denied" }) })).toBe("已拒绝");
  expect(toolOutcomeLabel({ ...data, result: undefined })).toBe("完成");
  expect(toolOutcomeLabel({ ...data, status: "running" })).toBe("执行中");
  expect(toolOutcomeLabel({ ...data, status: "failed" })).toBe("失败");
  expect(toolOutcomeLabel({ ...data, result: result({ status: "approved" }, true) })).toBe("失败");
  expect(
    toolOutcomeLabel({ name: "wait_for_message", status: "complete", result: result({}, true) }),
  ).toBe("失败");
});

it("accepts only object summaries and keeps malformed, redacted and error results readable", () => {
  expect(parsedToolOutput(result(null))).toBeUndefined();
  expect(parsedToolOutput(result([{}, null]))).toBeUndefined();
  expect(
    parsedToolOutput({ content: [null, { type: "text", text: '{"status":"pending"}' }] }),
  ).toEqual({ status: "pending" });
  expect(parsedToolOutput({ content: "plain node content" })).toEqual({
    content: "plain node content",
  });
  expect(
    readableToolOutput({ result: result({ error: { message: "permission changed" } }, true) }),
  ).toBe("permission changed");
  expect(
    readableToolOutput({ result: { content: [null, { type: "text", text: "malformed {" }] } }),
  ).toBe("malformed {");
  expect(boundedToolText("A".repeat(13000))).toContain("展示已截断");
  expect(boundedToolText("A".repeat(13000)).length).toBeLessThan(12100);
  expect(
    readableToolOutput({ result: { content: [{ type: "text", text: { toString: null } }] } }),
  ).toBe("");
  expect(toolLabel("__proto__")).toBe("__proto__");
  expect(
    toolOutcomeLabel({
      name: "review_access_request",
      status: "complete",
      result: result({ status: "__proto__" }),
    }),
  ).toBe("__proto__");
});

it("distinguishes approval outcomes, command failure and an unsuccessful wait", () => {
  expect(toolOutcomeLabel({ status: "waiting", waitingReason: "approval" })).toBe("等待审批");
  for (const approvalStatus of ["expired", "denied", "cancelled", "invalidated"])
    expect(toolOutcomeLabel({ status: "failed", approvalStatus })).toContain("未执行");
  expect(toolOutcomeLabel({ name: "wait_for_message", status: "error" })).toBe("失败");
  expect(toolOutcomeLabel({ name: "wait_for_message", status: "complete" })).toContain(
    "已让出执行",
  );
  const bash = {
    name: "bash",
    status: "complete",
    result: {
      content: [{ type: "text", text: JSON.stringify({ exitCode: 2, output: "first\nsecond" }) }],
    },
  };
  expect(toolOutcomeLabel(bash)).toBe("命令退出码 2");
  expect(readableToolOutput(bash)).toBe("first\nsecond");
  expect(
    toolOutcomeLabel({ name: "rg", status: "complete", result: { matches: [], truncated: true } }),
  ).toBe("搜索未完整");
  expect(
    toolOutcomeLabel({ name: "rg", status: "complete", result: { matches: [], truncated: false } }),
  ).toBe("无匹配");
});

it("preserves original image results and ignores late progress without losing final corrections", () => {
  const result = { content: [{ type: "image", data: "original", mimeType: "image/png" }] };
  const initial = {
    kind: "tool",
    conversationId: "one",
    data: { callId: "call", status: "complete", result },
  };
  const callback = {
    kind: "tool_update",
    conversationId: "one",
    data: { callId: "call", status: "succeeded", result: { content: [{ type: "image" }] } },
  };
  const lateProgress = {
    kind: "tool_update",
    conversationId: "one",
    data: { callId: "call", status: "running", progress: true },
  };
  expect(coalesceToolEvents([initial, callback, lateProgress])).toMatchObject([
    { data: { status: "succeeded", result } },
  ]);
  expect(
    coalesceToolEvents([{ ...initial, data: { ...initial.data, status: "unknown" } }, callback])[0]!
      .data.result,
  ).toEqual(callback.data.result);
});

it("does not merge separate conversations or tools without durable identity", () => {
  const tool = {
    kind: "tool",
    conversationId: "one",
    data: { callId: "call", status: "complete" },
  };
  const anonymous = { kind: "tool", data: { name: "read" } };
  expect(
    coalesceToolEvents([tool, { ...tool, conversationId: "two" }, anonymous, anonymous]),
  ).toHaveLength(4);
});
