import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { HostExecutor } from "../../../adapters/host/executor.js";
import { digest, type Sql, type Tx } from "../../../adapters/postgres/database.js";
import type { ToolResult } from "../../execution/tool-calls.js";
import { readObservationReader } from "./read-access.js";

export type ReadTarget =
  | { kind: "path"; path: string }
  | { kind: "node"; nodeId: string }
  | { kind: "skill"; skillId: string };
export type ReadObservation = {
  sourceKey: string;
  target: ReadTarget;
  sourceVersion: string;
  position: Record<string, unknown>;
  nextCursor: string | null;
  contentHash: string;
};

/** Reopening uses public read fields; long text lines may intentionally be read again. */
export function reopenReadTarget(
  target: ReadTarget,
  sourceVersion: string,
  position: Record<string, any>,
) {
  const { kind, ...source } = target;
  const next = position.next ?? {};
  return {
    ...source,
    sourceVersion,
    ...(kind !== "skill" && position.unit === "lines"
      ? { line: Math.max(next.line ?? position.line ?? 1, next.targetLine ?? 1) }
      : {}),
    ...(position.unit === "pdf_page" ? { page: next.page ?? position.page } : {}),
    ...(position.unit === "frame" ? { frame: position.frame } : {}),
    ...(kind !== "path" &&
    position.unit !== "frame" &&
    !(next.page !== undefined && next.page !== position.page) &&
    (next.offset ?? position.end ?? position.offset) !== undefined
      ? { characterOffset: next.offset ?? position.end ?? position.offset }
      : {}),
  };
}

/** Derive ranges from the successful reader output, never from requested offsets or lines. */
export function observedRead(
  kind: ReadTarget["kind"],
  data: Record<string, any>,
  output: ToolResult,
  sourceVersion: string,
  nextCursor: string | null,
): ReadObservation | null {
  if (output.isError) return null;
  const identity = kind === "node" ? (data.nodeId ?? data.id) : data.path;
  if (typeof identity !== "string" || !identity || !sourceVersion) return null;
  const target: ReadTarget =
    kind === "node"
      ? { kind, nodeId: identity }
      : kind === "skill"
        ? { kind, skillId: identity }
        : { kind, path: identity };
  const text =
    typeof data.text === "string"
      ? data.text
      : typeof data.content === "string"
        ? data.content
        : null;
  const position: Record<string, unknown> = {
    returnedChars: text?.length ?? 0,
    imagesReturned: output.content.filter((part) => part.type === "image").length,
    state: data.state ?? (nextCursor ? "reading" : "segment_complete"),
  };
  if (data.mediaType === "image") {
    Object.assign(position, { unit: "frame", frame: data.frame, frames: data.frames });
  } else if (data.mediaType === "pdf" || data.field === "pdf") {
    Object.assign(position, {
      unit: "pdf_page",
      page: data.page,
      pageCount: data.pageCount,
      offset: data.offset,
    });
  } else if (Array.isArray(data.entries)) {
    Object.assign(position, {
      unit: "directory_entries",
      returnedEntries: data.entries.length,
      totalEntries: data.total,
    });
  } else if (
    data.returnedLines !== undefined ||
    data.nextPosition?.line !== undefined ||
    data.state === "positioning" ||
    (kind === "path" && data.offset !== undefined)
  ) {
    Object.assign(position, {
      unit: "lines",
      line: data.offset,
      column: data.column ?? 0,
      returnedLines: data.returnedLines ?? 0,
    });
  } else {
    const end = data.nextOffset ?? data.totalChars;
    Object.assign(position, {
      unit: "characters",
      ...(typeof end === "number" && text !== null ? { offset: end - text.length, end } : {}),
    });
  }
  const nextPosition =
    data.nextPosition ??
    (data.nextOffset != null
      ? {
          offset: data.nextOffset,
          ...(data.nextColumn !== undefined ? { column: data.nextColumn } : {}),
          ...(data.page !== undefined ? { page: data.page } : {}),
        }
      : data.nextPage != null
        ? { page: data.nextPage }
        : null);
  if (nextPosition) position.next = nextPosition;
  return {
    sourceKey: `${kind}:${identity}`,
    target,
    sourceVersion,
    position,
    nextCursor,
    contentHash: digest(output.content),
  };
}

/** Persist only durable successful receipts already present in this checkpoint. Idempotent. */
export async function recordReadObservations(
  tx: Tx,
  conversationId: string,
  messages: AgentMessage[],
) {
  const ids = [
    ...new Set(
      messages.flatMap((message) => {
        const restored = message as AgentMessage & {
          intricaCallId?: string;
          intrica?: { kind?: string };
        };
        if (
          restored.intricaCallId &&
          ((message.role === "toolResult" && !message.isError) ||
            (message.role === "user" && restored.intrica?.kind === "input"))
        )
          return [restored.intricaCallId];
        if (message.role !== "toolResult" || message.isError) return [];
        const call = (message.details as ToolResult["details"] | undefined)?.call as
          | { callId?: string; state?: string }
          | undefined;
        return call?.state === "succeeded" && call.callId ? [call.callId] : [];
      }),
    ),
  ];
  if (!ids.length) return;
  const calls = await tx.query(
    `select t.id,t.result,coalesce(t.completed_at,t.updated_at) as completed_at from tool_calls t join runs r on r.id=t.run_id
     where r.subject_id=$1 and t.id=any($2::text[]) and t.name in ('read','read_next')
       and t.state='succeeded' and not exists(select 1 from read_observations o where o.tool_call_id=t.id)`,
    [conversationId, ids],
  );
  for (const call of calls.rows) {
    const output = call.result as ToolResult;
    const observation = output?.details?.readObservation as ReadObservation | undefined;
    if (output?.isError || !observation || !observation.sourceKey || !observation.sourceVersion)
      continue;
    await tx.query(
      `insert into read_observations(tool_call_id,conversation_id,source_key,target,source_version,position,next_cursor,content_hash,created_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(tool_call_id) do nothing`,
      [
        call.id,
        conversationId,
        observation.sourceKey,
        JSON.stringify(observation.target),
        observation.sourceVersion,
        JSON.stringify(observation.position),
        observation.nextCursor,
        observation.contentHash,
        call.completed_at,
      ],
    );
  }
}

/** Internal projection for an already-authorized conversation; no file body or completion claim. */
export async function recentReadObservations(
  sql: Sql,
  conversationId: string,
  host: Pick<HostExecutor, "assertPath">,
) {
  const allowed = await readObservationReader(sql, conversationId, host);
  const rows = await sql.query(
    `select latest.*,exists(select 1 from read_cursors c where c.id=latest.next_cursor and c.conversation_id=$1 and c.expires_at>now()) as cursor_valid from (
       select distinct on(source_key) tool_call_id,source_key,target,source_version,position,next_cursor,created_at
       from read_observations where conversation_id=$1 order by source_key,created_at desc,tool_call_id desc
     ) latest order by created_at desc,tool_call_id desc limit 8`,
    [conversationId],
  );
  let remaining = 6000;
  const entries = [];
  for (const row of rows.rows) {
    if (!(await allowed(row.target))) continue;
    const entry = {
      evidenceRef: row.tool_call_id,
      source: row.target,
      sourceVersion: row.source_version,
      position: row.position,
      nextCursor: row.cursor_valid ? row.next_cursor : null,
      ...(row.next_cursor && !row.cursor_valid
        ? { reopen: reopenReadTarget(row.target, row.source_version, row.position) }
        : {}),
      observation: "tool_returned" as const,
    };
    const size = JSON.stringify(entry).length;
    if (size > remaining) continue;
    remaining -= size;
    entries.push(entry);
  }
  return entries;
}
