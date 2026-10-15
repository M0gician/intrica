import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DomainError, digest } from "../../../adapters/postgres/database.js";
import { type ContextMessage, visibleMessageText } from "../../context/messages.js";

/** Text is preserved verbatim. Provider reasoning and binary media never enter the index. */
export type ArchiveSource = {
  role: string;
  text: string;
  hash: string;
  timestamp?: number;
  originalSummaryId?: string;
  originalMessageId?: string;
  logicalToolCallId?: string;
  toolName?: string;
  isError?: boolean;
  evidenceRef?: string;
};

export function archiveSources(messages: AgentMessage[]): ArchiveSource[] {
  return messages.map((message) => {
    const metadata = (message as ContextMessage).intrica;
    const backgroundCallId = (message as AgentMessage & { intricaCallId?: string }).intricaCallId;
    const receipt =
      message.role === "toolResult"
        ? (message.details as { call?: { callId?: string } } | undefined)?.call
        : undefined;
    const evidenceRef = backgroundCallId ?? receipt?.callId;
    return {
      role: backgroundCallId && metadata?.kind === "input" ? "toolResult" : message.role,
      text: visibleMessageText(message),
      hash: digest(message),
      ...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}),
      ...(evidenceRef ? { evidenceRef } : {}),
      ...(metadata?.kind === "summary" ? { originalSummaryId: metadata.id } : {}),
      ...(metadata?.kind === "input" || metadata?.kind === "instruction"
        ? { originalMessageId: metadata.id }
        : {}),
      ...(message.role === "toolResult"
        ? {
            logicalToolCallId: message.toolCallId,
            toolName: message.toolName,
            isError: message.isError,
          }
        : {}),
    };
  });
}

export function archiveReference(id: string, source?: number | "summary") {
  return `context:${id}${source === undefined ? "" : `:${source}`}`;
}

export function parseArchiveReference(ref: string) {
  const match = /^context:([^:]{1,200})(?::(summary|0|[1-9][0-9]{0,8}))?$/.exec(ref);
  if (!match)
    throw new DomainError(
      "CONTEXT_REFERENCE",
      "Use a ref returned by read_context / 使用 read_context 返回的 ref",
    );
  return {
    id: match[1]!,
    source:
      match[2] === undefined
        ? undefined
        : match[2] === "summary"
          ? ("summary" as const)
          : Number(match[2]),
  };
}

export function sourcePreview(text: string, query = "", limit = 180) {
  const found = query ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : 0;
  const start = Math.max(0, found - 60);
  return `${start ? "…" : ""}${text.slice(start, start + limit)}${start + limit < text.length ? "…" : ""}`;
}

export function sourcePage(source: ArchiveSource, offset = 0, limit = 6000) {
  if (offset > source.text.length)
    throw new DomainError("CONTEXT_OFFSET", "offset is outside this source / offset 超出来源范围");
  // Offsets use JavaScript string positions, but no returned page splits a surrogate pair.
  if (
    offset > 0 &&
    /[\uDC00-\uDFFF]/.test(source.text[offset]!) &&
    /[\uD800-\uDBFF]/.test(source.text[offset - 1]!)
  )
    throw new DomainError(
      "CONTEXT_OFFSET",
      "Use the returned nextOffset / 请使用返回的 nextOffset",
    );
  let end = Math.min(offset + limit, source.text.length);
  if (
    end < source.text.length &&
    /[\uD800-\uDBFF]/.test(source.text[end - 1]!) &&
    /[\uDC00-\uDFFF]/.test(source.text[end]!)
  )
    end = end - 1 === offset ? end + 1 : end - 1;
  const { text: _text, ...metadata } = source;
  return {
    ...metadata,
    text: source.text.slice(offset, end),
    offset,
    totalCharacters: source.text.length,
    offsetUnit: "utf16" as const,
    nextOffset: end < source.text.length ? end : null,
  };
}
