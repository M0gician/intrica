import type {
  ContextArchiveEntry,
  ContextLibraryQuery,
  ContextLibraryResponse,
} from "@intrica/contracts";
import {
  type Database,
  DomainError,
  digest,
  type Sql,
} from "../../../adapters/postgres/database.js";
import type { Actor } from "../../access/policy.js";
import { archiveReader } from "./access.js";
import {
  type ArchiveSource,
  archiveReference,
  parseArchiveReference,
  sourcePage,
  sourcePreview,
} from "./projection.js";
import {
  archiveColumns,
  archiveSearchMatches,
  searchArchives,
  searchSources,
  sourceEntry,
} from "./search.js";

function summaryText(content: unknown): string {
  if (
    content &&
    typeof content === "object" &&
    "text" in content &&
    typeof content.text === "string"
  )
    return content.text;
  // Old records remain audit data, but never become a new generation contract.
  return typeof content === "string" ? content : JSON.stringify(content ?? {});
}

function archiveEntry(row: any): ContextArchiveEntry {
  return {
    ref: archiveReference(row.id),
    archiveId: row.id,
    version: Number(row.context_version) + 1,
    createdAt: new Date(row.created_at).toISOString(),
    sourceCount: Number(row.source_count),
    excerpt: sourcePreview(summaryText(row.content)),
  };
}

/** Shared model/UI projection. Call under a canvas transaction to serialize permission changes. */
async function queryLibrary(
  sql: Sql,
  actor: Actor,
  canvasId: string,
  conversationId: string,
  args: ContextLibraryQuery,
): Promise<ContextLibraryResponse> {
  const permitted = await archiveReader(sql, actor, canvasId, conversationId);
  const offset = args.offset ?? 0;
  const query = (args.query ?? "").trim();
  if (!args.ref) {
    const limit = Math.min(args.limit ?? 20, 40);
    const rows = await searchArchives(sql, conversationId, query, offset, limit + 1);
    const allowed: any[] = [];
    for (const row of rows.slice(0, limit))
      if (await permitted(row.access_scope)) allowed.push(row);
    const matches = query ? await archiveSearchMatches(sql, allowed, query) : null;
    const archives: ContextArchiveEntry[] = allowed.map((row) => ({
      ...archiveEntry(row),
      ...(matches ? { matches: matches.get(row.id) ?? [] } : {}),
    }));
    return {
      kind: "directory",
      conversationId,
      archives,
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  }
  const ref = parseArchiveReference(args.ref);
  const row = (
    await sql.query(
      `select ${archiveColumns} from context_summaries s where s.id=$1 and s.conversation_id=$2`,
      [ref.id, conversationId],
    )
  ).rows[0];
  if (!row || !(await permitted(row.access_scope)))
    throw new DomainError(
      "NOT_FOUND",
      "Context source unavailable under current access / 当前权限下无法读取此资料",
    );
  if (ref.source !== undefined) {
    if (query)
      throw new DomainError(
        "CONTEXT_QUERY",
        "Search the directory or archive, then read a returned source ref / 先检索目录或版本，再读取返回的来源 ref",
      );
    const source =
      ref.source === "summary"
        ? { role: "summary", text: summaryText(row.content), hash: digest(row.content) }
        : ((
            await sql.query(
              "select source_messages->$2::int as source from context_summaries where id=$1",
              [ref.id, ref.source],
            )
          ).rows[0]?.source as ArchiveSource | undefined);
    if (!source)
      throw new DomainError("NOT_FOUND", "Context source does not exist / 此资料段不存在");
    return {
      kind: "source",
      conversationId,
      ref: args.ref,
      archiveId: ref.id,
      sourceIndex: ref.source === "summary" ? null : ref.source,
      ...sourcePage(source, offset, args.limit ?? 6000),
    };
  }
  const limit = Math.min(args.limit ?? 20, 40);
  const rows = await searchSources(sql, ref.id, query, offset, limit + 1);
  const sources = rows
    .slice(0, limit)
    .map(({ source, source_index }) => sourceEntry(ref.id, source, Number(source_index), query));
  const summary = summaryText(row.content);
  return {
    kind: "archive",
    conversationId,
    ...archiveEntry(row),
    summary: summary.slice(0, 6000),
    summaryCharacters: summary.length,
    summaryTruncated: summary.length > 6000,
    summaryRef: archiveReference(ref.id, "summary"),
    sources,
    nextOffset: rows.length > limit ? offset + limit : null,
  };
}

export function readContextLibrary(
  db: Database,
  actor: Actor,
  canvasId: string,
  conversationId: string,
  args: ContextLibraryQuery = {},
) {
  return db.canvas(canvasId, (tx) => queryLibrary(tx, actor, canvasId, conversationId, args));
}

/** The authenticated desktop/web owner can inspect their own canvas history. */
export async function readOwnerContextLibrary(
  db: Database,
  conversationId: string,
  args: ContextLibraryQuery = {},
) {
  const row = (
    await db.pool.query("select canvas_id from conversations where id=$1", [conversationId])
  ).rows[0];
  if (!row) throw new DomainError("NOT_FOUND", "Context library unavailable / 资料索引不存在");
  return readContextLibrary(db, { kind: "owner" }, row.canvas_id, conversationId, args);
}
