import type { ContextSourceEntry } from "@intrica/contracts";
import { digest, type Sql } from "../../../adapters/postgres/database.js";
import { archiveReference, sourcePreview } from "./projection.js";

export const archiveColumns =
  "s.id,s.content,s.context_version,s.created_at,s.access_scope,jsonb_array_length(s.source_messages) as source_count";

/** Literal substring terms, separated by whitespace. Ranking is lexical, not semantic. */
export function contextSearchTerms(query: string) {
  return [...new Set(query.toLowerCase().split(/\s+/u).filter(Boolean))].slice(0, 24);
}

export function contextMatchOffset(text: string, query: string) {
  if (!query) return null;
  const lower = text.toLowerCase();
  const full = lower.indexOf(query.toLowerCase());
  if (full >= 0) return full;
  const matches = contextSearchTerms(query)
    .map((term) => lower.indexOf(term))
    .filter((offset) => offset >= 0);
  return matches.length ? Math.min(...matches) : null;
}

export function sourceEntry(
  archiveId: string,
  source: any,
  index: number,
  query: string,
): ContextSourceEntry {
  const matchOffset = contextMatchOffset(source.text, query);
  return {
    ref: archiveReference(archiveId, index),
    index,
    role: source.role,
    hash: source.hash,
    characters: source.text.length,
    excerpt: sourcePreview(
      source.text,
      matchOffset === null ? "" : source.text.slice(matchOffset, matchOffset + 30),
    ),
    matchOffset,
    ...(source.logicalToolCallId ? { logicalToolCallId: source.logicalToolCallId } : {}),
    ...(source.evidenceRef ? { evidenceRef: source.evidenceRef } : {}),
    ...(source.toolName ? { toolName: source.toolName, isError: source.isError } : {}),
    ...(source.originalSummaryId
      ? { originalSummaryRef: archiveReference(source.originalSummaryId) }
      : {}),
  };
}

export async function searchArchives(
  sql: Sql,
  conversationId: string,
  query: string,
  offset: number,
  limit: number,
) {
  return (
    await sql.query(
      `select ${archiveColumns} from context_summaries s cross join lateral (
       select count(*)::int as score from unnest($4::text[]) term
       where strpos(lower(coalesce(s.content->>'text',s.content::text)||s.source_messages::text),term)>0
     ) matched where s.conversation_id=$1 and jsonb_array_length(s.source_messages)>0
       and ($5='' or matched.score>0)
     order by matched.score desc,s.context_version desc,s.id offset $2 limit $3`,
      [conversationId, offset, limit, contextSearchTerms(query), query],
    )
  ).rows;
}

export async function searchSources(
  sql: Sql,
  archiveId: string,
  query: string,
  offset: number,
  limit: number,
) {
  return (
    await sql.query(
      `select source,ordinality-1 as source_index from context_summaries s,
       jsonb_array_elements(s.source_messages) with ordinality as item(source,ordinality)
       cross join lateral (select count(*)::int as score from unnest($3::text[]) term
         where strpos(lower(source->>'text'),term)>0) matched
     where s.id=$1 and ($2='' or matched.score>0)
     order by matched.score desc,ordinality offset $4 limit $5`,
      [archiveId, query, contextSearchTerms(query), offset, limit],
    )
  ).rows;
}

/** Called only after the archive's source permissions have passed. */
export async function archiveSearchMatches(sql: Sql, archives: any[], query: string) {
  const rows = archives.length
    ? (
        await sql.query(
          `select s.id as archive_id,matched.* from context_summaries s cross join lateral (
       select source,ordinality-1 as source_index,ranked.score as match_score from jsonb_array_elements(s.source_messages)
       with ordinality as item(source,ordinality)
       cross join lateral (select count(*)::int as score from unnest($3::text[]) term
         where strpos(lower(source->>'text'),term)>0) ranked
       where ($2='' or ranked.score>0) order by ranked.score desc,ordinality limit 2
     ) matched where s.id=any($1::text[]) order by s.id,matched.match_score desc,matched.source_index`,
          [archives.map((row) => row.id), query, contextSearchTerms(query)],
        )
      ).rows
    : [];
  const byArchive = new Map<string, ContextSourceEntry[]>();
  for (const row of rows) {
    const entries = byArchive.get(row.archive_id) ?? [];
    entries.push(sourceEntry(row.archive_id, row.source, Number(row.source_index), query));
    byArchive.set(row.archive_id, entries);
  }
  return new Map(
    archives.map((row) => [row.id, archiveMatches(row, query, byArchive.get(row.id) ?? [])]),
  );
}

function archiveMatches(row: any, query: string, matches: ContextSourceEntry[]) {
  const summary =
    typeof row.content?.text === "string" ? row.content.text : JSON.stringify(row.content);
  const matchOffset = contextMatchOffset(summary, query);
  if (!matches.length && matchOffset !== null)
    return [
      {
        ref: archiveReference(row.id, "summary"),
        role: "summary",
        hash: digest(row.content),
        matchOffset,
        excerpt: sourcePreview(summary, summary.slice(matchOffset, matchOffset + 30)),
      },
    ];
  return matches;
}
