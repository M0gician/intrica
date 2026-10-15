import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DomainError, type Tx } from "../../../adapters/postgres/database.js";
import { agentIdentity, grantsFor } from "../../access/policy.js";
import { type ArchiveAccessScope, mergeArchiveScopes } from "./access.js";
import { archiveSources } from "./projection.js";

/** Called only inside the successful compaction transaction, under its existing run fence. */
export async function persistContextArchive(
  tx: Tx,
  input: {
    summaryId: string;
    conversationId: string;
    canvasId: string;
    agentId: string | null;
    sourceMessages: AgentMessage[];
  },
) {
  const sources = archiveSources(input.sourceMessages);
  const receiptIds = [
    ...new Set(sources.flatMap((source) => (source.evidenceRef ? [source.evidenceRef] : []))),
  ];
  if (receiptIds.length) {
    const receipts = (
      await tx.query(
        "select t.id,t.name,t.state from tool_calls t join runs r on r.id=t.run_id where r.subject_id=$1 and t.id=any($2::text[])",
        [input.conversationId, receiptIds],
      )
    ).rows;
    for (const source of sources) {
      if (!source.evidenceRef) continue;
      const receipt = receipts.find((row) => row.id === source.evidenceRef);
      if (!receipt) delete source.evidenceRef;
      else {
        source.toolName = receipt.name;
        source.isError = receipt.state === "failed" || receipt.state === "unknown";
      }
    }
  }
  const grants = input.agentId ? await grantsFor(tx, input.agentId) : [];
  const identity = input.agentId ? await agentIdentity(tx, input.agentId) : null;
  if (identity && identity.canvas_id !== input.canvasId)
    throw new DomainError(
      "FORBIDDEN",
      "Context library belongs to another canvas / 资料索引属于其他画布",
    );
  const own: ArchiveAccessScope = {
    version: 1,
    ownerOnly: !input.agentId,
    hostExecution:
      identity?.config.role === "admin" || grants.some((grant) => grant.execution_mode === "host"),
    resources: grants
      .filter((grant) => grant.resource_kind !== "agent")
      .map((grant) => ({
        id: grant.resource_id,
        ...(grant.resource ? { resource: grant.resource } : {}),
      })),
  };
  const priorIds = [
    ...new Set(
      sources.flatMap((source) => (source.originalSummaryId ? [source.originalSummaryId] : [])),
    ),
  ];
  const prior = priorIds.length
    ? (
        await tx.query(
          "select id,access_scope from context_summaries where conversation_id=$1 and id=any($2::text[])",
          [input.conversationId, priorIds],
        )
      ).rows
    : [];
  // Unknown legacy provenance remains owner-readable; never guess a narrower scope.
  const inherited = priorIds.map(
    (id) => prior.find((row) => row.id === id)?.access_scope ?? { ...own, ownerOnly: true },
  );
  const saved = await tx.query(
    `update context_summaries s set source_messages=$3,access_scope=$4
     from conversations c where s.id=$1 and s.conversation_id=$2 and c.id=s.conversation_id and c.canvas_id=$5`,
    [
      input.summaryId,
      input.conversationId,
      JSON.stringify(sources),
      JSON.stringify(mergeArchiveScopes([own, ...inherited])),
      input.canvasId,
    ],
  );
  if (saved.rowCount !== 1)
    throw new DomainError(
      "NOT_FOUND",
      "Context archive commit target unavailable / 资料版本提交目标不存在",
    );
}
