import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contextTail, estimatedMessageTokens } from "../../adapters/model/context.js";
import { digest } from "../../adapters/postgres/database.js";
import type { PromptLanguage } from "../../prompt-language.js";
import { cleanContext, isSummary, visibleMessageText } from "./messages.js";

/** Sanitize once, then freeze the source identity before assigning archive references. */
export function selectCompactionSources(
  messages: AgentMessage[],
  contextWindow: number,
  language: PromptLanguage,
) {
  const parts = contextTail(
    cleanContext(messages).map((message) =>
      message.role === "assistant"
        ? { ...message, content: message.content.filter((part) => part.type !== "thinking") }
        : message,
    ),
    contextWindow,
    language,
  );
  const sourceMessages = [...parts.older, ...parts.tail.filter(isSummary)];
  return {
    sourceMessages,
    sourceHash: digest(sourceMessages),
    retainedTail: parts.tail.filter((message) => !isSummary(message)),
  };
}

/** Only model-facing tool previews are shortened. Archive source text remains complete. */
export function renderCompactionSources(
  sourceMessages: AgentMessage[],
  archiveId: string,
  contextWindow: number,
) {
  const entries = sourceMessages.map((message, index) => ({
    message,
    text: visibleMessageText(message),
    ref: `context:${archiveId}:${index}`,
    hash: digest(message),
  }));
  const render = (previewLimit: number) =>
    entries
      .map(({ message, text, ref }) => {
        if (isSummary(message))
          return `[previous-summary ${ref}; preserve the complete handoff]\n${text}`;
        const preview =
          message.role === "toolResult" && text.length > previewLimit
            ? `${text.slice(0, previewLimit)}\n[Preview only. Full ${text.length} characters are preserved at ${ref}; use read_context to retrieve any omitted evidence.]`
            : text;
        return `[source ${ref}; role=${message.role}${message.role === "toolResult" ? `; tool=${message.toolName}; isError=${Boolean(message.isError)}` : ""}]\n${preview}`;
      })
      .join("\n\n");
  let transcript = render(6000);
  for (const limit of [2000, 512]) {
    if (
      estimatedMessageTokens({ role: "user", content: transcript, timestamp: 0 }) <=
      contextWindow * 0.65
    )
      break;
    transcript = render(limit);
  }
  return { sources: entries.map(({ ref, hash }) => ({ ref, hash })), transcript };
}
