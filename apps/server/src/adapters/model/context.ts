import {
  type AgentMessage,
  estimateContextTokens,
  estimateTokens,
  serializeConversation,
} from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentContextUsage } from "@intrica/contracts";
import { type PromptLanguage, promptText } from "../../prompt-language.js";
import type { Agent } from "./agent.js";
import { modelContextWindow } from "./model-catalog.js";
import type { ModelConfig } from "./types.js";

export type { AgentMessage } from "@earendil-works/pi-agent-core";

function textTokens(text: string) {
  let units = 0;
  for (const char of text) units += char.codePointAt(0)! > 127 ? 1.5 : 1 / 3;
  return Math.ceil(units);
}
export function estimatedMessageTokens(message: AgentMessage) {
  const text = ["user", "assistant", "toolResult"].includes(message.role)
    ? serializeConversation([message as Message])
    : "";
  return Math.max(estimateTokens(message), textTokens(text));
}
export function contextTail(
  messages: AgentMessage[],
  contextWindow: number,
  language: PromptLanguage = "en",
) {
  const saved = checkpointMessages(messages, language);
  // A cut is legal only after every call in an assistant message has its result.
  // The final complete group may be summarized too, even when it is the only group.
  const boundaries = [0],
    pending = new Set<string>();
  for (const [index, message] of saved.entries()) {
    if (message.role === "assistant")
      for (const part of message.content) if (part.type === "toolCall") pending.add(part.id);
    if (message.role === "toolResult") pending.delete(message.toolCallId);
    if (!pending.size) boundaries.push(index + 1);
  }
  const budget = Math.min(20000, Math.floor(contextWindow * 0.1));
  let cut = saved.length,
    tokens = 0;
  for (let index = boundaries.length - 2; index >= 1; index--) {
    const start = boundaries[index]!;
    const size = saved.slice(start, cut).reduce((total, m) => total + estimatedMessageTokens(m), 0);
    if (tokens + size > budget) break;
    tokens += size;
    cut = start;
  }
  return {
    older: saved.slice(0, cut),
    tail: saved.slice(cut).map((m) =>
      m.role === "assistant"
        ? {
            ...m,
            usage: { ...m.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          }
        : m,
    ),
  };
}

export function contextUsage(
  agent: Agent,
  config: ModelConfig,
  messages = agent.state.messages,
  options: { estimateOnly?: boolean } = {},
): AgentContextUsage {
  // Zero usage from a mock/endpoint is unavailable, not proof of an empty context.
  const usable = messages.map((m) =>
    m.role === "assistant" &&
    (options.estimateOnly ||
      (m.usage &&
        !(
          m.usage.totalTokens ||
          m.usage.input ||
          m.usage.output ||
          m.usage.cacheRead ||
          m.usage.cacheWrite
        )))
      ? ({ ...m, usage: undefined } as unknown as AgentMessage)
      : m,
  );
  const estimate = estimateContextTokens(usable);
  const overhead = textTokens(
    agent.state.systemPrompt +
      JSON.stringify(
        agent.state.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      ),
  );
  const window = modelContextWindow(config);
  const safeLimit = Math.max(
    1024,
    Math.floor(window.contextWindow * 0.8) -
      Math.min(agent.state.model.maxTokens, Math.floor(window.contextWindow * 0.15)),
  );
  return {
    ...window,
    tokens: Math.max(
      0,
      estimate.lastUsageIndex === null
        ? messages.reduce((n, m) => n + estimatedMessageTokens(m), overhead)
        : estimate.usageTokens +
            messages
              .slice(estimate.lastUsageIndex + 1)
              .reduce((n, m) => n + estimatedMessageTokens(m), 0),
    ),
    safeLimit,
    source: estimate.lastUsageIndex === null ? "estimated" : "usage",
    modelId: agent.state.model.id,
    state: "ready",
    compactions: 0,
  };
}

/** Checkpoints are private runtime state, with images re-read from graph assets on demand. */
export function checkpointMessages(
  messages: AgentMessage[],
  language: PromptLanguage = "en",
): AgentMessage[] {
  const results = new Set(messages.flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])));
  const calls = new Set(
    messages.flatMap((m) =>
      m.role === "assistant" && !["error", "aborted"].includes(m.stopReason)
        ? m.content.flatMap((p) => (p.type === "toolCall" && results.has(p.id) ? [p.id] : []))
        : [],
    ),
  );
  return messages
    .map((m): AgentMessage => {
      if (m.role !== "assistant" || !["error", "aborted"].includes(m.stopReason)) return m;
      const draft = m.content
        .flatMap((part) =>
          part.type === "text" ? [part.text] : part.type === "thinking" ? [part.thinking] : [],
        )
        .join("\n")
        .trim();
      // Provider-specific reasoning signatures and incomplete tool calls cannot be replayed.
      const { errorMessage: _error, ...message } = m;
      return {
        ...message,
        stopReason: "stop",
        content: draft
          ? [
              {
                type: "text",
                text: `${promptText(language, "[Interrupted unfinished draft: reference only, not evidence that tools ran or work completed]", "[此前中断的未完成草稿，仅供继续任务参考，不代表工具已执行或任务已完成]")}\n${draft}`,
              },
            ]
          : [],
      };
    })
    .filter((m) => m.role !== "toolResult" || calls.has(m.toolCallId))
    .map((m) => {
      if (m.role === "assistant")
        m = { ...m, content: m.content.filter((p) => p.type !== "toolCall" || calls.has(p.id)) };
      if (!("content" in m) || !Array.isArray(m.content)) return m;
      return {
        ...m,
        content: m.content.map((part) =>
          part.type === "image"
            ? {
                type: "text",
                text: promptText(
                  language,
                  "[Image omitted from restored context; use read with the node target to read it again if needed.]",
                  "[图片未保留在恢复上下文中，需要时用 read 的 node 目标 重新读取。]",
                ),
              }
            : part,
        ),
      } as AgentMessage;
    })
    .filter((m) => m.role !== "assistant" || m.content.length > 0);
}
