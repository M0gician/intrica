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
import { type Agent, createCanvasAgent } from "./agent.js";
import { modelCapabilities, modelContextWindow } from "./model-catalog.js";
import { buildCompactionPrompt } from "./prompt.js";
import type { ModelConfig } from "./types.js";
import { withModelPurpose } from "./usage.js";

export type { AgentMessage } from "@earendil-works/pi-agent-core";

function textTokens(text: string) {
  let units = 0;
  for (const char of text) units += char.codePointAt(0)! > 127 ? 1.5 : 1 / 3;
  return Math.ceil(units);
}
function estimatedMessageTokens(message: AgentMessage) {
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

export function parseContextSummary(
  text: string,
  truncated = false,
): { summary: string; memory?: { title: string; text: string } } | null {
  if (truncated) return null;
  const raw = text.trim();
  const plain = raw.replace(/^```(?:json|markdown|md)?\s*|\s*```$/g, "").trim();
  const candidates = [
    plain,
    ...[...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]!),
    plain.slice(plain.indexOf("{"), plain.lastIndexOf("}") + 1),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (
        typeof parsed?.summary !== "string" ||
        !parsed.summary.trim() ||
        parsed.summary.length > 10000
      )
        continue;
      const memory = parsed.memory;
      const validMemory =
        memory &&
        typeof memory.title === "string" &&
        typeof memory.text === "string" &&
        memory.text.trim() &&
        memory.text.length <= 8000;
      return {
        summary: parsed.summary,
        ...(validMemory
          ? { memory: { title: memory.title.slice(0, 120), text: memory.text } }
          : {}),
      };
    } catch {
      /* Try the next complete envelope, then plain Markdown. */
    }
  }
  if (!plain || plain.length > 10000 || /^[{["`]/.test(plain) || /["']summary["']\s*:/.test(plain))
    return null;
  return { summary: plain };
}

function compactSummaryMessages(
  messages: AgentMessage[],
  language: PromptLanguage,
): AgentMessage[] {
  return messages.map((message) => {
    if (message.role === "toolResult") {
      return {
        ...message,
        content: message.content.map((part) =>
          part.type === "text" && part.text.length > 1800
            ? {
                ...part,
                text: `${part.text.slice(0, 900)}\n${promptText(language, "[…Tool output abbreviated…]", "[…工具结果已压缩…]")}\n${part.text.slice(-900)}`,
              }
            : part,
        ),
      };
    }
    if (message.role === "assistant") {
      return {
        ...message,
        content: message.content
          .filter((part) => part.type !== "thinking")
          .map((part) =>
            part.type === "text" && part.text.length > 6000
              ? {
                  ...part,
                  text: `${part.text.slice(0, 3000)}\n${promptText(language, "[…Answer abbreviated…]", "[…回答已压缩…]")}\n${part.text.slice(-3000)}`,
                }
              : part,
          ),
      };
    }
    if (
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.length > 10000
    )
      return {
        ...message,
        content: `${message.content.slice(0, 5000)}\n${promptText(language, "[…User input abbreviated…]", "[…用户输入已压缩…]")}\n${message.content.slice(-5000)}`,
      };
    return message;
  });
}

export type ContextSummary = {
  summary: string;
  memory?: { title: string; text: string };
  retainedTail: AgentMessage[];
};
/** Uses the same PI transport/key/model selection as normal turns; no graph tools during maintenance. */
export async function summarizeContext(
  config: ModelConfig,
  messages: AgentMessage[],
  saveMemory: boolean,
  signal?: AbortSignal,
  language: PromptLanguage = "en",
): Promise<ContextSummary> {
  if (signal?.aborted) throw new Error("上下文整理已停止");
  const parts = contextTail(messages, modelContextWindow(config).contextWindow, language);
  if (config.kind === "mock")
    return {
      retainedTail: parts.tail,
      summary: promptText(
        language,
        "Earlier tasks, results, and next steps have been summarized.",
        "已整理此前任务、处理结果与下一步。",
      ),
      ...(saveMemory
        ? {
            memory: {
              title: promptText(language, "Conversation notes", "会话要点"),
              text: promptText(
                language,
                "Key conclusions and next steps from the mock conversation.",
                "模拟会话整理出的关键结论与待办。",
              ),
            },
          }
        : {}),
    };
  const summarizer = createCanvasAgent(config, `compact-${crypto.randomUUID()}`);
  if (modelCapabilities(config).thinkingLevels.includes("off"))
    summarizer.state.thinkingLevel = "off";
  summarizer.state.systemPrompt = buildCompactionPrompt(language, saveMemory);
  const serialized = serializeConversation(
    compactSummaryMessages(checkpointMessages(parts.older, language), language).filter(
      (m): m is Message => ["user", "assistant", "toolResult"].includes(m.role),
    ),
  );
  const window = modelContextWindow(config).contextWindow;
  if (
    estimatedMessageTokens({ role: "user", content: serialized, timestamp: Date.now() }) >
    window * 0.8
  )
    throw new Error("上下文过大，无法安全整理；历史已保留，请缩小模型输入或改用更大窗口的模型。");
  const abort = () => summarizer.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 300_000);
  try {
    let value: ReturnType<typeof parseContextSummary> = null;
    let failure = "供应商未返回可用摘要";
    // PI may resolve a failed turn with stopReason=error instead of throwing.
    // Treat both forms alike and retry once with the newest part of the source.
    for (let attempt = 0; attempt < 2 && !value; attempt++) {
      if (signal?.aborted) throw new Error("上下文整理已停止");
      summarizer.state.messages = [];
      const source =
        attempt === 0
          ? serialized
          : `${serialized.slice(0, 2000)}\n${promptText(language, "[…Middle history omitted…]", "[…中间历史省略…]")}\n${serialized.slice(-22000)}`;
      const instruction =
        attempt === 0
          ? source
          : `${promptText(language, "Return only a complete Markdown conversation summary, without JSON, introductions, or notes. Preserve tasks, constraints, key paths, completed and pending work, within 6000 characters.", "请仅输出完整的 Markdown 会话摘要，不要 JSON、开场说明或笔记；保留任务、约束、关键路径、已完成和待完成事项，最多 6000 字符。")}\n${source}`;
      try {
        await withModelPurpose("compaction", () => summarizer.prompt(instruction));
      } catch (error) {
        failure = error instanceof Error ? error.message.slice(0, 300) : "供应商错误";
        continue;
      }
      const last = summarizer.state.messages.at(-1);
      if (last?.role !== "assistant" || ["error", "aborted"].includes(last.stopReason)) {
        failure =
          last?.role === "assistant"
            ? last.errorMessage?.slice(0, 300) || "供应商未完成响应"
            : "供应商未完成响应";
        continue;
      }
      const text = last.content
        .flatMap((p) => (p.type === "text" ? [p.text] : []))
        .join("\n")
        .replace(/^```(?:json|markdown|md)?\s*|\s*```$/g, "")
        .trim();
      value = parseContextSummary(text, last.stopReason === "length");
      if (!value) failure = "摘要格式不完整";
    }
    if (!value) throw new Error(`上下文整理未完成：${failure}；原会话已保留，可继续重试。`);
    return {
      summary: value.summary,
      retainedTail: parts.tail,
      ...(saveMemory && value.memory
        ? { memory: { title: value.memory.title.slice(0, 120), text: value.memory.text } }
        : {}),
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
