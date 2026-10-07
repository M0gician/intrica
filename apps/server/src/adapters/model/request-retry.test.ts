import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { createCanvasAgent } from "./agent.js";
import { checkpointMessages } from "./context.js";
import { retryTimedOutRequests } from "./request-retry.js";

const model = createCanvasAgent({ kind: "mock" }, "fixture").state.model;
const message = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  timestamp: 0,
  stopReason: "stop",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});

it("retries a partial timeout in the same inference slot without replaying the preceding tool", async () => {
  let requests = 0,
    executions = 0;
  const source: StreamFn = (_model, context) => {
    requests++;
    const stream = createAssistantMessageEventStream();
    if (requests === 1) {
      stream.push({
        type: "done",
        reason: "toolUse",
        message: {
          ...message(""),
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "write-once", name: "write", arguments: {} }],
        },
      });
    } else if (requests === 2) {
      stream.push({ type: "start", partial: message("未完成草稿") });
      stream.push({
        type: "error",
        reason: "error",
        error: { ...message("未完成草稿"), stopReason: "error", errorMessage: "ETIMEDOUT" },
      });
    } else {
      expect(context.messages.filter((m) => m.role === "toolResult")).toHaveLength(1);
      stream.push({ type: "start", partial: message("") });
      stream.push({ type: "done", reason: "stop", message: message("完成") });
    }
    return stream;
  };
  const agent = new Agent({
    initialState: { model },
    streamFn: retryTimedOutRequests(source, { retryDelayMs: 0 }),
  });
  agent.state.tools = [
    {
      name: "write",
      label: "write",
      description: "fixture",
      parameters: { type: "object", properties: {} } as never,
      execute: async () => {
        executions++;
        return { content: [{ type: "text", text: "saved" }], details: {} };
      },
    },
  ];
  await agent.prompt("任务");
  expect(requests).toBe(3);
  expect(executions).toBe(1);
  expect(agent.state.messages.map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "toolResult",
    "assistant",
  ]);
  expect(JSON.stringify(agent.state.messages.at(-1))).toContain("完成");
});

it("bounds unresponsive requests even when the provider ignores abort", async () => {
  let requests = 0;
  const stream = await retryTimedOutRequests(
    () => {
      requests++;
      return createAssistantMessageEventStream();
    },
    { idleMs: 10, retryDelayMs: 0 },
  )(model, { messages: [] });
  const last = await stream.result();
  expect(last.stopReason).toBe("error");
  expect(last.errorMessage).toContain("timed out");
  expect(requests).toBe(3);
});

it("never retries explicit cancellation or permanent provider errors", async () => {
  let requests = 0;
  const abort = new AbortController();
  const stream = await retryTimedOutRequests(
    () => {
      requests++;
      return createAssistantMessageEventStream();
    },
    { idleMs: 100, retryDelayMs: 0 },
  )(model, { messages: [] }, { signal: abort.signal });
  abort.abort();
  expect((await stream.result()).stopReason).toBe("aborted");
  expect(requests).toBe(1);
  const failed = await retryTimedOutRequests(
    () => {
      requests++;
      throw new Error("401 unauthorized");
    },
    { retryDelayMs: 0 },
  )(model, { messages: [] });
  expect((await failed.result()).errorMessage).toBe("401 unauthorized");
  expect(requests).toBe(2);
});

it("preserves interrupted prose as a draft without replaying incomplete tools or reasoning signatures", () => {
  const saved = checkpointMessages([
    {
      ...message("草稿"),
      stopReason: "aborted",
      content: [
        { type: "thinking", thinking: "尚待核查的假设", thinkingSignature: "provider-signature" },
        { type: "text", text: "未完成文字" },
        { type: "toolCall", id: "incomplete", name: "write", arguments: {} },
      ],
    },
  ]);
  expect(JSON.stringify(saved)).toContain("Interrupted unfinished draft");
  expect(JSON.stringify(saved)).toContain("尚待核查的假设");
  expect(JSON.stringify(saved)).toContain("未完成文字");
  expect(JSON.stringify(saved)).not.toContain("provider-signature");
  expect(JSON.stringify(saved)).not.toContain("toolCall");
});
