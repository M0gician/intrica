import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { DomainError, digest, type Tx } from "../../adapters/postgres/database.js";
import type { ContextMessage, ContextProvenance } from "./types.js";

/** Entry versions describe the exact context passed to an attempt, including after compaction. */
export async function persistContext(tx: Tx, conversationId: string, messages: AgentMessage[]) {
  const saved = new Map(
    (
      await tx.query(
        "select seq,content_hash from context_entries where conversation_id=$1 and seq=any($2::bigint[])",
        [
          conversationId,
          (messages as ContextMessage[]).flatMap((message) =>
            message.intrica?.contextSeq ? [message.intrica.contextSeq] : [],
          ),
        ],
      )
    ).rows.map((row) => [String(row.seq), row.content_hash]),
  );
  for (const message of messages as ContextMessage[]) {
    const { intrica, ...content } = message;
    const hash = digest(content);
    if (
      intrica?.contextSeq &&
      intrica.contentHash === hash &&
      saved.get(intrica.contextSeq) === hash
    )
      continue;
    const row = (
      await tx.query(
        "update conversations set context_seq=context_seq+1 where id=$1 returning context_seq",
        [conversationId],
      )
    ).rows[0];
    message.intrica = { ...intrica, contextSeq: String(row.context_seq), contentHash: hash };
    await tx.query(
      "insert into context_entries(conversation_id,seq,content_hash,message,provenance) values($1,$2,$3,$4,$5)",
      [
        conversationId,
        row.context_seq,
        hash,
        JSON.stringify(content),
        JSON.stringify(message.intrica),
      ],
    );
  }
  return messages;
}

export function contextManifest(messages: AgentMessage[], contextSeq?: string) {
  const entries = (messages as ContextMessage[]).map((message, index) => ({
    index,
    role: message.role,
    ...message.intrica,
  }));
  return {
    contextSeq:
      contextSeq ??
      entries.reduce(
        (max, e) =>
          BigInt(e.contextSeq ?? e.snapshotContextSeq ?? 0) > BigInt(max)
            ? (e.contextSeq ?? e.snapshotContextSeq)!
            : max,
        "0",
      ),
    entries,
    inputIds: entries.flatMap((e) => e.inputIds ?? []),
    itemVersions: entries.flatMap((e) => e.itemVersions ?? []),
  };
}

export function provenance(message: AgentMessage): ContextProvenance {
  return (message as ContextMessage).intrica ?? {};
}

/** Prevent SDK fallback conversion of private reasoning and synthetic orphan tool responses. */
export function providerHistory(
  messages: AgentMessage[],
  model: Model<Api>,
  keepProvenance = false,
) {
  const pending = new Set<string>();
  const result = messages.map((entry) => {
    const message = structuredClone(entry) as ContextMessage;
    if (!keepProvenance) delete message.intrica;
    if (message.role === "assistant") {
      if (pending.size) throw new DomainError("CONTEXT_INCOMPLETE", "工具调用缺少持久回执");
      const retained: number[] = [];
      message.content = message.content.filter((part, index) => {
        const keep =
          part.type !== "thinking" ||
          (message.api === model.api &&
            message.provider === model.provider &&
            message.model === model.id);
        if (keep) retained.push(index);
        return keep;
      });
      if (message.intrica?.itemVersions)
        message.intrica.itemVersions = retained.flatMap((index) =>
          message.intrica!.itemVersions![index] ? [message.intrica!.itemVersions![index]!] : [],
        );
      for (const part of message.content) if (part.type === "toolCall") pending.add(part.id);
    } else if (message.role === "toolResult") {
      if (!pending.delete(message.toolCallId))
        throw new DomainError("CONTEXT_INCOMPLETE", "工具回执缺少对应调用或重复");
    } else if (pending.size)
      throw new DomainError("CONTEXT_INCOMPLETE", "追加输入前需要工具的真实回执");
    return message;
  });
  if (pending.size) throw new DomainError("CONTEXT_INCOMPLETE", "模型请求包含缺少回执的工具调用");
  return result.filter((message) => message.role !== "assistant" || message.content.length > 0);
}
