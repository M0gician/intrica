import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createCanvasAgent } from "../../adapters/model/agent.js";
import { estimatedMessageTokens } from "../../adapters/model/context.js";
import { modelCapabilities, modelContextWindow } from "../../adapters/model/model-catalog.js";
import type { ModelConfig } from "../../adapters/model/types.js";
import { modelPurposeRequestId, withModelPurpose } from "../../adapters/model/usage.js";
import { DomainError, digest } from "../../adapters/postgres/database.js";
import { type PromptLanguage, promptText } from "../../prompt-language.js";
import { contextFailure } from "./errors.js";
import { renderCompactionSources, selectCompactionSources } from "./sources.js";
import {
  buildCompactionPrompt,
  SUMMARY_TEMPLATE_VERSION,
  type SummaryContent,
  validateContextSummary,
} from "./summary-contract.js";

export type ContextSummary = {
  id: string;
  requestId: string;
  content: SummaryContent;
  sourceHash: string;
  sources: Array<{ ref: string; hash: string }>;
  sourceMessages: AgentMessage[];
  retainedTail: AgentMessage[];
};

/** Freeze source and archive identity before inference; commit them with the checkpoint. */
export async function summarizeContext(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  language: PromptLanguage = "en",
  onSource?: (count: number) => void,
): Promise<ContextSummary> {
  signal?.throwIfAborted();
  const window = modelContextWindow(config).contextWindow;
  const source = selectCompactionSources(messages, window, language);
  const requestId = modelPurposeRequestId(
    "compaction",
    digest([SUMMARY_TEMPLATE_VERSION, language, source.sourceHash]),
  );
  const summaryId = `summary-${digest(requestId)}`;
  onSource?.(source.sourceMessages.length);
  if (!source.sourceMessages.length) throw contextFailure("CONTEXT_EMPTY_SOURCE", language);
  const { transcript, sources } = renderCompactionSources(source.sourceMessages, summaryId, window);
  const metadata = { id: summaryId, requestId, ...source, sources };
  if (config.kind === "mock")
    return {
      ...metadata,
      content: {
        text: promptText(
          language,
          "Earlier test history is archived. Continue the original instructions and inspect the preserved evidence when needed.",
          "测试历史已存入资料索引。继续原始任务，需要细节时查询保留的证据。",
        ),
      },
    };
  const summarizer = createCanvasAgent({
    ...config,
    maxOutputTokens: Math.min(
      config.maxOutputTokens ?? 8192,
      8192,
      Math.max(256, Math.floor(window * 0.08)),
    ),
  });
  if (modelCapabilities(config).thinkingLevels.includes("off"))
    summarizer.state.thinkingLevel = "off";
  summarizer.state.systemPrompt = buildCompactionPrompt(language);
  if (
    estimatedMessageTokens({
      role: "user",
      content: transcript + summarizer.state.systemPrompt,
      timestamp: 0,
    }) >
    window * 0.8
  )
    throw new DomainError(
      "CONTEXT_SOURCE_LIMIT",
      promptText(
        language,
        "The protected source exceeds the summary budget. The complete checkpoint is preserved; use a larger context or narrow the active instructions.",
        "必须保留的来源超过摘要预算。完整会话记录已保留，请使用更大的上下文窗口或明确缩小有效指令范围。",
      ),
    );
  const abort = () => summarizer.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await withModelPurpose(
      "compaction",
      () => summarizer.prompt(transcript),
      requestId,
      validateContextSummary,
    );
    signal?.throwIfAborted();
    return { ...metadata, content: validateContextSummary(response) };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
