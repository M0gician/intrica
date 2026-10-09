import { type Database, DomainError } from "../../adapters/postgres/database.js";

/** Owner diagnostic projection: stable IDs and timings, without prompts, arguments or credentials. */
export async function conversationTrace(db: Database, conversationId: string) {
  if (
    !(
      await db.pool.query(
        "select 1 from conversations c join canvases v on v.id=c.canvas_id where c.id=$1 and v.deleted_at is null",
        [conversationId],
      )
    ).rowCount
  )
    throw new DomainError("NOT_FOUND", "会话不存在");
  const runs = (
    await db.pool.query(
      "select id,cause_id,epoch,state,reason,created_at,updated_at,frozen_input->>'requestId' as request_id from runs where subject_id=$1 order by created_at desc limit 100",
      [conversationId],
    )
  ).rows;
  const ids = runs.map((r) => r.id);
  const [inputs, attempts, models, tools, approvals] = await Promise.all([
    db.pool.query(
      "select client_message_id as id,content->>'requestId' as request_id,seq,run_id,consumed_run_id,created_at,consumed_at,extract(epoch from(consumed_at-created_at))*1000 as queue_ms from messages where conversation_id=$1 and role='user' order by seq desc limit 1000",
      [conversationId],
    ),
    db.pool.query(
      "select id,run_id,epoch,state,created_at,ended_at from attempts where run_id=any($1) order by created_at limit 2000",
      [ids],
    ),
    db.pool.query(
      "select id,run_id,attempt_id,request_id,provider,model_id,provider_request_id,response_id,started_at,first_response_at,finished_at,outcome,usage_status,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,extract(epoch from(first_response_at-started_at))*1000 as first_response_ms,extract(epoch from(finished_at-started_at))*1000 as total_ms from model_calls where run_id=any($1) order by started_at limit 2000",
      [ids],
    ),
    db.pool.query(
      "select t.id,t.logical_call_id,t.run_id,t.attempt_id,t.name,t.state,t.created_at,t.dispatched_at,t.completed_at,t.approval_id,extract(epoch from(t.completed_at-t.dispatched_at))*1000 as execution_ms,extract(epoch from(t.dispatched_at-a.decided_at))*1000 as authorized_wait_ms from tool_calls t left join approvals a on a.id=t.approval_id where t.run_id=any($1) order by t.created_at limit 2000",
      [ids],
    ),
    db.pool.query(
      "select a.id,a.origin_call_id,a.status,a.created_at,a.decided_at,a.route_reason,extract(epoch from(a.decided_at-a.created_at))*1000 as wait_ms from approvals a join tool_calls t on t.id=a.origin_call_id where t.run_id=any($1) order by a.created_at limit 2000",
      [ids],
    ),
  ]);
  return {
    conversationId,
    runs,
    inputs: inputs.rows,
    attempts: attempts.rows,
    models: models.rows,
    tools: tools.rows,
    approvals: approvals.rows,
    inputTokenMeaning:
      "Input tokens include uncached input, cache reads and cache writes. Cache fields are subsets; do not add them again.",
    bounded:
      runs.length === 100 ||
      inputs.rows.length === 1000 ||
      [attempts, models, tools, approvals].some((r) => r.rows.length === 2000),
  };
}
