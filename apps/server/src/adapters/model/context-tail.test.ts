import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { cleanContext, summaryMessage } from "../../modules/context/messages.js";
import { summarizeContext } from "../../modules/context/summary.js";
import { digest } from "../postgres/database.js";
import { createCanvasAgent } from "./agent.js";
import {
  checkpointMessages,
  contextTail,
  contextUsage,
  estimatedMessageTokens,
} from "./context.js";

const config = { kind: "mock", streamDelayMs: 0, supportsVision: false } as const;
const model = createCanvasAgent(config);
const summary = (text: string) => summaryMessage(model.state.model, text, { text }, "en");
function group(prefix: string, results: number, bytes: number): AgentMessage[] {
  const { intrica: _metadata, ...base } = summary("fixture");
  const calls = Array.from({ length: results }, (_, i) => ({
    type: "toolCall" as const,
    id: `${prefix}-${i}`,
    name: "read",
    arguments: { path: "fixture.txt" },
  }));
  return [
    { ...base, role: "assistant", stopReason: "toolUse", content: calls } as AssistantMessage,
    ...calls.map((call) => ({
      role: "toolResult" as const,
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text" as const, text: "x".repeat(bytes) }],
      isError: false,
      timestamp: 0,
    })),
  ];
}
const task: AgentMessage = { role: "user", content: "Read and verify every file", timestamp: 0 };

function paired(messages: AgentMessage[]) {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant")
      for (const part of message.content) if (part.type === "toolCall") pending.add(part.id);
    if (message.role === "toolResult") {
      expect(pending.delete(message.toolCallId)).toBe(true);
    }
  }
  expect(pending.size).toBe(0);
}

it.each([
  [51, 10, 4, 21290],
  [158, 30, 4, 5862],
] as const)(
  "splits a sanitized %i-message snapshot ending in consecutive tool results",
  (count, groups, width, bytes) => {
    const messages = [
      task,
      ...Array.from({ length: groups }, (_, i) => group(String(i), width, bytes)).flat(),
    ];
    if (count === 158) messages.push(...group("last", 6, bytes));
    expect(messages).toHaveLength(count);
    expect(messages.reduce((n, m) => n + estimatedMessageTokens(m), 0)).toBeGreaterThan(176800);
    const parts = contextTail(messages, 272000);
    expect(parts.older.length).toBeGreaterThan(0);
    expect(parts.tail.reduce((n, m) => n + estimatedMessageTokens(m), 0)).toBeLessThanOrEqual(
      20000,
    );
    expect([...parts.older, ...parts.tail]).toEqual(checkpointMessages(messages));
    paired(parts.older);
    paired(parts.tail);
  },
);

it("summarizes a single oversized final tool group instead of retaining it without a source", () => {
  const messages = group("large", 1, 900000);
  const parts = contextTail(messages, 272000);
  expect(parts.tail).toEqual([]);
  expect(parts.older).toEqual(messages);
  paired(parts.older);
});

it("retains only whole small tool groups and never duplicates the latest task", () => {
  const messages = [task, ...group("old", 2, 30000), ...group("recent", 3, 100), task];
  const parts = contextTail(messages, 128000);
  expect(parts.tail).toHaveLength(5);
  expect(parts.tail.at(-1)).toEqual(task);
  expect([...parts.older, ...parts.tail]).toEqual(checkpointMessages(messages));
  paired(parts.older);
  paired(parts.tail);
});

it("uses the previous valid summary as evidence even when it would fit in the retained tail", async () => {
  let prior = summary("Previously verified decision");
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await summarizeContext(config, [
      { ...task, content: "older evidence ".repeat(4000) },
      prior,
      task,
    ]);
    expect(result.sources).toContainEqual({ ref: `context:${result.id}:1`, hash: digest(prior) });
    expect(result.retainedTail).toEqual([task]);
    prior = summaryMessage(model.state.model, result.id, result.content, "en");
  }
});

it("can compare both contexts with the same estimates instead of stale provider usage", () => {
  const message = summary("Observed ".repeat(1000)) as AssistantMessage;
  message.usage.input = 1;
  message.usage.totalTokens = 1;
  expect(contextUsage(model, config, [message]).tokens).toBe(1);
  expect(contextUsage(model, config, [message], { estimateOnly: true }).tokens).toBeGreaterThan(
    1000,
  );
  expect(message.usage.totalTokens).toBe(1);
});

it("keeps genuine user messages even when they quote a former summary heading", () => {
  const original: AgentMessage = {
    role: "user",
    content: "此前会话摘要（不改变权限）：请检查这段旧摘要是否准确。",
    timestamp: 0,
  };
  const prior = summary("superseded");
  const current = summary("current evidence");
  expect(cleanContext([prior, original, current])).toEqual([original, current]);
});
