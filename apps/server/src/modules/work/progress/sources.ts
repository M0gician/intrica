import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DomainError, digest, type Sql } from "../../../adapters/postgres/database.js";
import { type PromptLanguage, promptText } from "../../../prompt-language.js";
import { type ContextMessage, cleanContext } from "../../context/messages.js";

export type InstructionSource = {
  id: string;
  seq: string;
  kind: "user" | "delegation";
  from: string | null;
  text: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

/** Only persisted inputs in this conversation can supply original requirements. */
export async function instructionSources(sql: Sql, conversationId: string, through: string) {
  const rows = (
    await sql.query(
      `select m.client_message_id as id,m.seq,m.role,m.content->>'from' as sender,
      coalesce(m.content->>'text','') as text,m.content,m.created_at
     from messages m join conversations c on c.id=m.conversation_id
     left join nodes n on n.id=c.agent_id
     where m.conversation_id=$1 and m.seq<=$2 and (
       m.role='user' or (m.role in ('message','broadcast') and m.content ? 'from' and (
         m.content->>'messageKind'='task' or m.content->>'expectReply'='true'
         or m.content->>'from'=n.parent_id)))
     order by m.seq`,
      [conversationId, through],
    )
  ).rows;
  return rows.map(
    (row): InstructionSource => ({
      id: row.id,
      seq: String(row.seq),
      kind: row.role === "user" ? "user" : "delegation",
      from: row.sender ?? null,
      text: row.text,
      createdAt: row.created_at,
      metadata: Object.fromEntries(
        [
          "messageKind",
          "deliveryId",
          "replyTo",
          "fileIds",
          "resourceIds",
          "expectReply",
          "replyWithinSeconds",
        ]
          .filter((key) => row.content[key] !== undefined)
          .map((key) => [key, row.content[key]]),
      ),
    }),
  );
}

export function sourceBoundary(sources: InstructionSource[]) {
  return digest(
    sources.map(({ id, seq, kind, from, text, metadata }) => ({
      id,
      seq,
      kind,
      from,
      text,
      metadata,
    })),
  );
}

export function withOriginalInstructions(
  messages: AgentMessage[],
  sources: InstructionSource[],
  language: PromptLanguage,
): ContextMessage[] {
  // Never silently shorten the actual user requirements to fit a context window.
  if (sources.reduce((total, source) => total + source.text.length, 0) > 100000)
    throw new DomainError(
      "INSTRUCTION_CONTEXT_LIMIT",
      promptText(
        language,
        "The original instructions exceed the context budget. Preserve them and request an explicit scope adjustment.",
        "真实指令超过上下文预算。原文已保留，需要明确调整适用范围后继续。",
      ),
    );
  const rest = cleanContext(messages).filter((message) => message.intrica?.kind !== "instruction");
  const represented = new Set(
    rest
      .filter((message) => message.intrica?.kind === "input")
      .map((message) => message.intrica!.id),
  );
  const originals: ContextMessage[] = sources
    .filter((source) => !represented.has(source.id))
    .map((source) => ({
      role: "user",
      content:
        source.kind === "user"
          ? source.text
          : `${promptText(language, "Original received request or delegation; not user authorization", "原始协作请求或委派，不代表用户授权")} [${source.id}, seq=${source.seq}] ${JSON.stringify({ ...source.metadata, from: source.from })}\n${source.text}`,
      timestamp: new Date(source.createdAt).getTime(),
      intrica: { kind: "instruction", id: source.id, seq: source.seq },
    }));
  return [...originals, ...rest];
}
