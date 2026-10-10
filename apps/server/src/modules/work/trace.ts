import { type Database, DomainError } from "../../adapters/postgres/database.js";

/** Owner diagnostic projection: stable IDs and timings, without prompts, arguments or credentials. */
export async function conversationTrace(
  db: Database,
  conversationId: string,
  includeDiagnostics = false,
) {
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
  const [
    inputs,
    attempts,
    models,
    tools,
    approvals,
    messages,
    observations,
    requests,
    dispatches,
    messageSummary,
    inferenceRequests,
    inferenceAttempts,
    outputItems,
  ] = await Promise.all([
    db.pool.query(
      "select client_message_id as id,content->>'requestId' as request_id,content->>'workItemId' as work_item_id,content->>'collaborationRequestId' as message_request_id,seq,run_id,consumed_run_id,cutover_request_id,created_at,consumed_at,extract(epoch from(consumed_at-created_at))*1000 as queue_ms from messages where conversation_id=$1 and (role='user' or role='message' and content ? 'from') order by seq desc limit 1000",
      [conversationId],
    ),
    db.pool.query(
      "select id,run_id,epoch,state,created_at,ended_at from attempts where run_id=any($1) order by created_at limit 2000",
      [ids],
    ),
    db.pool.query(
      "select id,run_id,attempt_id,inference_attempt_id,request_id,generation_id,work_item_id,provider,model_id,provider_request_id,response_id,started_at,first_response_at,finished_at,outcome,usage_status,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,manifest,diagnostics_expires_at,case when $2 and diagnostics_expires_at>now() then diagnostics end as diagnostics,extract(epoch from(first_response_at-started_at))*1000 as first_response_ms,extract(epoch from(finished_at-started_at))*1000 as total_ms from model_calls where run_id=any($1) order by started_at limit 2000",
      [ids, includeDiagnostics],
    ),
    db.pool.query(
      "select t.id,t.work_item_id,t.generation,t.logical_call_id,t.run_id,t.attempt_id,t.inference_item_id,(t.primary_response is not null) as has_primary_response,t.name,t.state,t.created_at,t.dispatched_at,t.completed_at,t.approval_id,t.audit,t.retry_of,t.model_call_id,t.observation_id,extract(epoch from(t.completed_at-t.dispatched_at))*1000 as execution_ms,extract(epoch from(t.dispatched_at-a.decided_at))*1000 as authorized_wait_ms from tool_calls t left join approvals a on a.id=t.approval_id where t.run_id=any($1) order by t.created_at limit 2000",
      [ids],
    ),
    db.pool.query(
      "select a.id,a.origin_call_id,a.origin_dispatch_id,a.status,a.created_at,a.decided_at,a.route_reason,extract(epoch from(a.decided_at-a.created_at))*1000 as wait_ms from approvals a left join tool_calls t on t.id=a.origin_call_id left join message_dispatches d on d.id=a.origin_dispatch_id where coalesce(t.run_id,d.run_id)=any($1) order by a.created_at limit 2000",
      [ids],
    ),
    db.pool.query(
      "select seq,role,run_id,content->>'messageId' as message_id,content->>'collaborationRequestId' as message_request_id,content->>'workItemId' as work_item_id,content->>'inReplyTo' as in_reply_to,content->>'generation' as generation,content->>'generationId' as generation_id,consumed_at,created_at from messages where conversation_id=$1 order by seq desc limit 2000",
      [conversationId],
    ),
    db.pool.query(
      `select o.id,o.model_call_id,o.content_index,o.provider_call_id,o.name,o.argument_hash,o.raw_argument_hash,o.parsed_type,o.parse_error,o.created_at,o.updated_at,
      case when $2 and c.diagnostics_expires_at>now() then o.diagnostics end as diagnostics
      from model_tool_observations o join model_calls c on c.id=o.model_call_id where c.run_id=any($1) order by c.started_at,o.content_index limit 2000`,
      [ids, includeDiagnostics],
    ),
    db.pool.query(
      "select id,message_id,sender_kind,sender_conversation_id,recipient_kind,recipient_conversation_id,origin_work_item_id,parent_request_id,cause_id,state,work_state,reply_message_id,blocked_reason,version,takeover_run_id,created_at,updated_at,case when state in('answered','declined') then extract(epoch from(updated_at-created_at))*1000 end as reply_ms from message_requests where sender_conversation_id=$1 or recipient_conversation_id=$1 order by created_at desc limit 2000",
      [conversationId],
    ),
    db.pool.query(
      "select id,logical_id,run_id,tool_call_id,origin,generation,work_item_id,state,approval_id,created_at,updated_at from message_dispatches where conversation_id=$1 order by created_at desc limit 2000",
      [conversationId],
    ),
    db.pool.query(
      `select count(*) filter(where state='open')::int as pending,
      count(*) filter(where state='open' and blocked_reason is not null)::int as blocked,
      avg(extract(epoch from(updated_at-created_at))*1000) filter(where state in('answered','declined')) as mean_reply_ms,
      (select count(*)::int from messages where conversation_id=$1 and role='output_error' and content->>'code'='REQUEST_CLOSED') as duplicate_replies_rejected
      from message_requests where recipient_conversation_id=$1 or sender_conversation_id=$1`,
      [conversationId],
    ),
    db.pool.query(
      "select id,run_id,work_item_id,decision_revision,state,reason,created_at,sealed_at from inference_requests where conversation_id=$1 order by created_at desc limit 2000",
      [conversationId],
    ),
    db.pool.query(
      `select a.id,a.request_id,a.lease_epoch,a.ordinal,a.context_seq,a.state,a.capabilities,a.manifest,
      a.dispatched_at,a.cutover_at,a.settle_deadline,a.sealed_at,a.outcome
      from inference_attempts a join inference_requests q on q.id=a.request_id
      where q.conversation_id=$1 order by a.created_at desc limit 2000`,
      [conversationId],
    ),
    db.pool.query(
      `select i.id,i.attempt_id,i.ordinal,i.kind,i.state,i.version,i.protocol_group,i.context_seq,
      md5(i.payload::text) as payload_hash,i.publication,i.created_at,i.updated_at
      from inference_items i join inference_attempts a on a.id=i.attempt_id join inference_requests q on q.id=a.request_id
      where q.conversation_id=$1 order by i.created_at desc limit 2000`,
      [conversationId],
    ),
  ]);
  const stages = new Map<
    string,
    { phase: string; count: number; notExecuted: number; unknown: number }
  >();
  const stage = (phase: string) => {
    if (!stages.has(phase)) stages.set(phase, { phase, count: 0, notExecuted: 0, unknown: 0 });
    return stages.get(phase)!;
  };
  for (const row of tools.rows) {
    const s = stage(row.audit?.phase ?? "prepared");
    s.count++;
    if (row.audit?.executed === false) s.notExecuted++;
    if (row.state === "unknown") s.unknown++;
  }
  const linked = new Set(tools.rows.map((row) => row.observation_id));
  for (const observation of observations.rows)
    if (!linked.has(observation.id)) {
      const s = stage("observation");
      s.count++;
      s.notExecuted++;
    }
  return {
    stageSummary: [...stages.values()],
    conversationId,
    runs,
    inputs: inputs.rows,
    attempts: attempts.rows,
    models: models.rows,
    tools: tools.rows,
    approvals: approvals.rows,
    messages: messages.rows,
    requests: requests.rows,
    dispatches: dispatches.rows,
    messageSummary: messageSummary.rows[0],
    observations: observations.rows,
    inferenceRequests: inferenceRequests.rows,
    inferenceAttempts: inferenceAttempts.rows,
    outputItems: outputItems.rows,
    inputTokenMeaning:
      "Input tokens include uncached input, cache reads and cache writes. Cache fields are subsets; do not add them again.",
    bounded:
      runs.length === 100 ||
      inputs.rows.length === 1000 ||
      [
        attempts,
        models,
        tools,
        approvals,
        messages,
        requests,
        dispatches,
        observations,
        inferenceRequests,
        inferenceAttempts,
        outputItems,
      ].some((r) => r.rows.length === 2000),
  };
}
