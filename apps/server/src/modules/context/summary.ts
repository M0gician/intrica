import { type AgentMessage, serializeConversation } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { createCanvasAgent } from "../../adapters/model/agent.js";
import {
  checkpointMessages,
  contextTail,
  estimatedMessageTokens,
} from "../../adapters/model/context.js";
import { modelCapabilities, modelContextWindow } from "../../adapters/model/model-catalog.js";
import { buildCompactionPrompt } from "../../adapters/model/prompt.js";
import type { ModelConfig } from "../../adapters/model/types.js";
import { modelPurposeRequestId, withModelPurpose } from "../../adapters/model/usage.js";
import { DomainError, digest, id } from "../../adapters/postgres/database.js";
import { type PromptLanguage, promptText } from "../../prompt-language.js";
import { contextFailure } from "./errors.js";
import { cleanContext, isSummary } from "./messages.js";
import { parseContextSummary, type SummaryContent } from "./summary-contract.js";

export type ContextSummary = {
  id: string;
  requestId: string;
  content: SummaryContent;
  sourceHash: string;
  sources: Array<{ ref: string; hash: string }>;
  retainedTail: AgentMessage[];
};

function sourceMessages(messages: AgentMessage[]): Message[] {
  return checkpointMessages(messages)
    .filter((message): message is Message =>
      ["user", "assistant", "toolResult"].includes(message.role),
    )
    .map((message) => {
      if (message.role === "user") return message;
      return {
        ...message,
        content: message.content
          .filter((part) => part.type !== "thinking")
          .map((part) =>
            part.type === "text" && part.text.length > 6000
              ? {
                  ...part,
                  text: `${part.text.slice(0, 3000)}\n[Source excerpt shortened]\n${part.text.slice(-3000)}`,
                }
              : part,
          ),
      } as Message;
    });
}

/** Source IDs are assigned by the server; the model only cites this frozen set. */
export async function summarizeContext(
  config: ModelConfig,
  messages: AgentMessage[],
  saveMemory: boolean,
  signal?: AbortSignal,
  language: PromptLanguage = "en",
  onSource?: (count: number) => void,
): Promise<ContextSummary> {
  signal?.throwIfAborted();
  const parts = contextTail(
    cleanContext(messages),
    modelContextWindow(config).contextWindow,
    language,
  );
  // A retained old summary must become evidence for its replacement, never disappear.
  const original = checkpointMessages([...parts.older, ...parts.tail.filter(isSummary)], language);
  const source = sourceMessages(original);
  onSource?.(source.length);
  if (!source.length) throw contextFailure("CONTEXT_EMPTY_SOURCE", language);
  const sources = source.map((message, index) => ({ ref: `s${index + 1}`, hash: digest(message) }));
  const requestId = modelPurposeRequestId("compaction", digest(original));
  const metadata = {
    id: id("summary"),
    requestId,
    sources,
    sourceHash: digest(original),
    retainedTail: parts.tail.filter((message) => !isSummary(message)),
  };
  if (config.kind === "mock")
    return {
      ...metadata,
      content: {
        facts: [
          promptText(
            language,
            "Earlier records were summarized for the test conversation.",
            "测试会话的历史记录已整理。",
          ),
        ],
        decisions: [],
        completed_work: [],
        remaining_work: [],
        source_refs: sources.map((s) => s.ref),
        ...(saveMemory
          ? { memory_title: "Conversation notes", memory_text: "Test conversation evidence." }
          : {}),
      },
    };
  const summarizer = createCanvasAgent(config, requestId);
  if (modelCapabilities(config).thinkingLevels.includes("off"))
    summarizer.state.thinkingLevel = "off";
  summarizer.state.systemPrompt = buildCompactionPrompt(language, saveMemory);
  const transcript = source
    .map((message, index) => `[source ${sources[index]!.ref}]\n${serializeConversation([message])}`)
    .join("\n\n");
  if (
    estimatedMessageTokens({ role: "user", content: transcript, timestamp: 0 }) >
    modelContextWindow(config).contextWindow * 0.8
  )
    throw new DomainError(
      "CONTEXT_SOURCE_LIMIT",
      promptText(
        language,
        "The source exceeds the summarization context budget. The existing checkpoint is preserved.",
        "来源内容超过摘要上下文预算，原 checkpoint 已保留。",
      ),
    );
  const abort = () => summarizer.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    // Request retry belongs to the shared model scheduler, never a second summary loop.
    await withModelPurpose(
      "compaction",
      () => summarizer.prompt(transcript),
      requestId,
      (message) => {
        if (
          !parseContextSummary(
            message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
            new Set(sources.map((s) => s.ref)),
            message.stopReason !== "stop",
          )
        )
          throw new DomainError(
            "CONTEXT_SUMMARY_INVALID",
            "CONTEXT_SUMMARY_INVALID: summary structure or references rejected / 摘要结构或来源引用无效",
          );
      },
    );
    signal?.throwIfAborted();
    const last = summarizer.state.messages.at(-1);
    const content =
      last?.role === "assistant"
        ? parseContextSummary(
            last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
            new Set(sources.map((source) => source.ref)),
            last.stopReason !== "stop",
          )
        : null;
    if (!content)
      throw new DomainError(
        "CONTEXT_SUMMARY_INVALID",
        promptText(
          language,
          "The summary has an invalid structure or source reference. The original instructions and checkpoint are preserved.",
          "摘要结构或来源引用无效。真实指令与原 checkpoint 已保留。",
        ),
      );
    if (!saveMemory) {
      delete content.memory_text;
      delete content.memory_title;
    }
    return { ...metadata, content };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
