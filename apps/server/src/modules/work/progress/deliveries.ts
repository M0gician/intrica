import type { Sql, Tx } from "../../../adapters/postgres/database.js";

export async function progressDeliveries(sql: Sql, runId: string): Promise<string[]> {
  return (
    await sql.query(
      `select id from tool_calls where run_id=$1 and name='send_message' and state='succeeded'
     and (execution_input->>'messageKind'='report' or execution_input ? 'replyTo') order by created_at`,
      [runId],
    )
  ).rows.map((row) => row.id);
}

/** A final send can follow review. Link its committed receipt without sending again. */
export async function linkProgressDeliveries(tx: Tx, conversationId: string, runId: string) {
  await tx.query(
    "update progress_reviews set delivery_call_ids=$3 where conversation_id=$1 and run_id=$2",
    [conversationId, runId, await progressDeliveries(tx, runId)],
  );
}

/** A natural-end hook verifies an already displayed answer, rather than asking for a duplicate. */
export async function hasReviewedAnswer(sql: Sql, conversationId: string, runId: string) {
  return Boolean(
    (
      await sql.query(
        `select 1 from messages m join progress_reviews p on p.conversation_id=m.conversation_id and p.run_id=m.run_id
     where m.conversation_id=$1 and m.run_id=$2 and p.outcome='completed' and m.seq>p.input_boundary::bigint
     and m.role='assistant' and m.content->>'stopReason'='stop' and length(trim(m.content->>'text'))>0
     and m.content#>>'{reviewBasis,executionHash}'=p.execution_hash
     and (m.content#>>'{reviewBasis,consumedInputSeq}')::bigint>=p.input_boundary::bigint limit 1`,
        [conversationId, runId],
      )
    ).rowCount,
  );
}
