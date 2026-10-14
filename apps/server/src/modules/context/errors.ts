import { DomainError } from "../../adapters/postgres/database.js";
import { type PromptLanguage, promptText } from "../../prompt-language.js";

const reasons = {
  CONTEXT_EMPTY_SOURCE: [
    "There is no history to summarize. The existing checkpoint is preserved.",
    "没有可用于摘要的历史内容，原会话记录已保留。",
  ],
  CONTEXT_COMPACTION_LIMIT: [
    "The summary did not reduce the context enough to continue. The existing checkpoint is preserved; narrow the task or choose a model with a larger context window.",
    "摘要未能充分缩小上下文，原会话记录已保留。请缩小任务范围或选择上下文窗口更大的模型。",
  ],
  INSTRUCTION_CONTEXT_LIMIT: [
    "The original instructions exceed the context budget. They are preserved; explicitly narrow the task or choose a model with a larger context window.",
    "真实指令超过上下文预算，原文已保留。请明确缩小任务范围或选择上下文窗口更大的模型。",
  ],
} as const;

export function contextFailure(code: keyof typeof reasons, language: PromptLanguage) {
  const [en, zh] = reasons[code];
  return new DomainError(code, `${code}: ${promptText(language, en, zh)}`);
}
