import {
  type AgentMessage,
  estimateContextTokens,
  estimateTokens,
  prepareCompaction,
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
  const entries = checkpointMessages(messages, language).map((message, i) => ({
    type: "message" as const,
    id: String(i),
    parentId: i ? String(i - 1) : null,
    seq: i,
    timestamp: message.timestamp ?? Date.now(),
    message,
  }));
  for (
    let keep = Math.min(4096, Math.floor(contextWindow * 0.05));
    keep >= 1;
    keep = Math.floor(keep / 2)
  ) {
    const result = prepareCompaction(entries, {
      enabled: true,
      reserveTokens: Math.floor(contextWindow * 0.2),
      keepRecentTokens: keep,
    });
    if (!result.ok || !result.value) break;
    const tail = result.value.retainedTail.map((m) =>
      m.role === "assistant"
        ? {
            ...m,
            usage: { ...m.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          }
        : m,
    );
    if (tail.reduce((n, m) => n + estimatedMessageTokens(m), 0) < contextWindow * 0.3 || keep === 1)
      return {
        older: [...result.value.messagesToSummarize, ...result.value.turnPrefixMessages],
        tail,
      };
  }
  return { older: messages, tail: messages.slice(-1).filter((m) => m.role === "user") };
}

export function contextUsage(
  agent: Agent,
  config: ModelConfig,
  messages = agent.state.messages,
): AgentContextUsage {
  // Zero usage from a mock/endpoint is unavailable, not proof of an empty context.
  const usable = messages.map((m) =>
    m.role === "assistant" &&
    m.usage &&
    !(
      m.usage.totalTokens ||
      m.usage.input ||
      m.usage.output ||
      m.usage.cacheRead ||
      m.usage.cacheWrite
    )
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
