import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  checkpointMessages,
  contextTail,
  estimatedMessageTokens,
} from "../../adapters/model/context.js";
import { digest } from "../../adapters/postgres/database.js";
import type { PromptLanguage } from "../../prompt-language.js";
import { cleanContext, isSummary } from "./messages.js";

/** Archive complete visible evidence; only the model-facing tool preview is shortened. */
export function compactionSources(
  messages: AgentMessage[],
  contextWindow: number,
  archiveId: string,
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
  const original = checkpointMessages([...parts.older, ...parts.tail.filter(isSummary)], language);
  const sourceMessages = original.map((message) =>
    message.role === "assistant"
      ? { ...message, content: message.content.filter((part) => part.type !== "thinking") }
      : message,
  );
  const sources = sourceMessages.map((message, index) => ({
    ref: `context:${archiveId}:${index}`,
    hash: digest(message),
  }));
  const render = (previewLimit: number) =>
    sourceMessages
      .map((message, index) => {
        const ref = sources[index]!.ref;
        const content = "content" in message ? message.content : "";
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .flatMap((part) =>
                    part.type === "text"
                      ? [part.text]
                      : part.type === "toolCall"
                        ? [
                            JSON.stringify({
                              toolCallId: part.id,
                              tool: part.name,
                              args: part.arguments,
                            }),
                          ]
                        : [],
                  )
                  .join("\n")
              : "";
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
  return {
    sourceMessages,
    sources,
    sourceHash: digest(sourceMessages),
    transcript,
    retainedTail: parts.tail.filter((message) => !isSummary(message)),
  };
}
