import type { ModelSelection } from "@intrica/contracts";
import { createCanvasAgent } from "../../adapters/model/agent.js";
import { contextUsage } from "../../adapters/model/context.js";
import type { ModelRegistry } from "../../adapters/model/registry.js";
import { type Database, DomainError, digest, type Tx } from "../../adapters/postgres/database.js";
import { agentIdentity } from "../access/policy.js";
import { conversationRequests, projectMessageReceipts } from "../collaboration/receipts.js";
import { listWaits } from "../collaboration/wait-notices.js";
import { Events } from "../execution/events.js";
import { resourceResponse } from "../execution/schedules.js";
import { CollaborationReader } from "./collaboration-reader.js";
import { ConversationNavigation } from "./conversation-navigation.js";
import { projectInputReceipts } from "./input-receipts.js";
import { canRetryUnknown } from "./tool-outcomes.js";

function publicContext(context: Record<string, unknown> | null) {
  if (!context) return null;
  const {
    pendingOutput: _pendingOutput,
    messageRepairAttempts: _repairs,
    messageProtocolBlocked: _blocked,
    outputGeneration: _generation,
    pendingTurnId: _pendingTurnId,
    toolSchemaVersion: _toolSchemaVersion,
    turnsSinceInput: _turns,
    turnLimitReached: _turnLimitReached,
    modelBlocked: _modelBlocked,
    ...usage
  } = context;
  return Object.keys(usage).length ? usage : null;
}
export class ConversationReader {
  readonly navigation: ConversationNavigation;
  readonly collaboration: CollaborationReader;
  constructor(
    readonly db: Database,
    readonly models: ModelRegistry,
  ) {
    this.navigation = new ConversationNavigation(db);
    this.collaboration = new CollaborationReader(db);
  }
  /** One owner-facing projection for both workspace and canvas Agent recovery. */
  private async unknownTools(conversationId: string) {
    const c = (
      await this.db.pool.query("select checkpoint,context from conversations where id=$1", [
        conversationId,
      ])
    ).rows[0];
    const calls = (
      await this.db.pool.query(
        `select t.id,t.name,t.args,t.args_hash,t.logical_call_id,t.is_async,t.result,
        r.state as run_state,r.id=(select id from runs where subject_id=$1 order by created_at desc,id desc limit 1) as is_current,
        t.run_id as "runId",t.created_at as "createdAt",t.updated_at as "updatedAt",
        t.execution_input->>'path' as "targetPath",t.execution_input->>'cwd' as "workingDirectory",
        (select e.created_at from run_events e where e.run_id=t.run_id and e.type='tool'
          and e.payload->>'callId'=t.id and e.payload->>'status'='running'
          order by e.seq desc limit 1) as "lastConfirmedAt"
       from tool_calls t join runs r on r.id=t.run_id where r.subject_id=$1 and t.state='unknown' order by t.created_at,t.id`,
        [conversationId],
      )
    ).rows;
    return calls.map(
      ({ args_hash, logical_call_id, is_async, run_state, is_current, ...call }) => ({
        ...call,
        canRetry: canRetryUnknown(
          { ...call, args_hash, logical_call_id, is_async, run_state, is_current },
          c.checkpoint,
          c.context,
        ),
      }),
    );
  }
  async forAgent(agentId: string, tx: Pick<Tx, "query"> = this.db.pool) {
    const row = (await tx.query("select * from conversations where agent_id=$1", [agentId]))
      .rows[0];
    if (!row) throw new DomainError("NOT_FOUND", "Agent 会话不存在");
    return row;
  }
  async context(conversationId: string, selection?: ModelSelection | null) {
    const row = (
      await this.db.pool.query("select * from conversations where id=$1", [conversationId])
    ).rows[0];
    const config = await this.models.resolve(selection);
    const model = createCanvasAgent(config, "inspect");
    model.state.messages = row?.checkpoint ?? [];
    return { ...contextUsage(model, config), compactions: row?.context?.compactions ?? 0 };
  }
  async history(conversationId: string, before?: string, around?: number) {
    const records = (
      await this.db.pool.query(
        `select seq,role,content,md5(content::text) as record_version,run_id,created_at from messages where role<>'model_output' and conversation_id=$1 and ($2::bigint is null or seq<$2)
         and ($3::bigint is null or seq>=$3) order by seq ${around === undefined ? "desc" : "asc"} limit 80`,
        [conversationId, before ?? null, around ?? null],
      )
    ).rows;
    if (around === undefined) records.reverse();
    return this.projectToolReceipts(records, conversationId);
  }
  async event(conversationId: string, seq: number) {
    const records = (
      await this.db.pool.query(
        "select seq,role,content,md5(content::text) as record_version,run_id,created_at from messages where conversation_id=$1 and seq=$2",
        [conversationId, seq],
      )
    ).rows;
    await this.projectToolReceipts(records, conversationId);
    if (!records[0]) throw new DomainError("NOT_FOUND", "Message not found");
    return records[0];
  }
  private async projectToolReceipts(records: any[], conversationId: string, bounded = false) {
    if (!bounded)
      for (const record of records)
        record.content = { ...record.content, truncated: false, truncatedFields: {} };
    await projectInputReceipts(this.db, records, conversationId);
    await projectMessageReceipts(this.db.pool, records, conversationId);
    const ids = records
      .filter((r) => ["tool", "tool_update"].includes(r.role))
      .map((r) => r.content.callId)
      .filter(Boolean);
    if (!ids.length) return records;
    const calls = (
      await this.db.pool.query(
        `select t.id,t.name,t.state,t.is_async,t.approval_id,greatest(t.updated_at,a.decided_at) as updated_at,a.status as approval_status,md5(t.result::text) as result_version,
      case when $3 and length(t.result::text)>4000 then jsonb_build_object('content',jsonb_build_array(
        jsonb_build_object('type','text','text',left(coalesce((select string_agg(p->>'text', E'\n')
          from jsonb_array_elements(t.result->'content') p where p->>'type'='text'),''),4000))))
        else t.result end as result,
      ($3 and length(t.result::text)>4000) as truncated
      from tool_calls t join runs r on r.id=t.run_id left join approvals a on a.id=t.approval_id
      where t.id=any($1::text[]) and r.subject_id=$2`,
        [ids, conversationId, bounded],
      )
    ).rows;
    const byId = new Map(calls.map((c) => [c.id, c]));
    for (const record of records) {
      const call = ["tool", "tool_update"].includes(record.role) && byId.get(record.content.callId);
      if (call) {
        record.record_version = digest([
          record.record_version,
          call.updated_at,
          call.state,
          call.approval_status,
          call.result_version,
        ]);
        const truncatedFields = {
          ...record.content.truncatedFields,
          result: Boolean(call.truncated),
        };
        record.content = {
          ...record.content,
          name: call.name,
          status:
            record.role === "tool_update"
              ? call.state
              : call.state === "succeeded"
                ? "complete"
                : call.state === "failed"
                  ? "error"
                  : call.state === "dispatching"
                    ? call.is_async
                      ? "background"
                      : "running"
                    : call.state,
          waitingReason: call.state === "waiting" && call.approval_id ? "approval" : null,
          approvalStatus: call.approval_status,
          updatedAt: new Date(call.updated_at).toISOString(),
          resultVersion: call.result_version,
          result:
            record.role === "tool_update" && call.result?.content
              ? {
                  ...call.result,
                  content: call.result.content.map((p: any) =>
                    p.type === "image"
                      ? {
                          type: "image",
                          mimeType: p.mimeType,
                          ...(p.intricaMedia ? { intricaMedia: p.intricaMedia } : {}),
                        }
                      : p,
                  ),
                }
              : call.result,
          truncated: Object.values(truncatedFields).some(Boolean),
          truncatedFields,
        };
      }
    }
    return records;
  }
  private async currentRun(conversationId: string) {
    return (
      (
        await this.db.pool.query(
          `select id,state,reason,last_event_seq,superseded_by_run_id from runs where subject_id=$1
           order by coalesce(reason='tool_contract_upgrade',false) desc,
             (state in('queued','running','waiting')) desc,created_at desc,id desc limit 1`,
          [conversationId],
        )
      ).rows[0] ?? null
    );
  }
  async view(conversationId: string) {
    const row = (
      await this.db.pool.query("select id,context from conversations where id=$1", [conversationId])
    ).rows[0];
    if (!row) return { messages: [], run: null, context: null };
    const messages = await this.history(conversationId);
    const current = await this.currentRun(conversationId);
    const run = current
      ? {
          id: current.id,
          state: current.state,
          reason: current.reason,
          last_event_seq: current.last_event_seq,
        }
      : null;
    const unknownTools = await this.unknownTools(conversationId);
    return {
      messages,
      run,
      context: publicContext(row.context),
      unknownTools,
      messageRequests: await conversationRequests(this.db.pool, conversationId),
      waits: await listWaits(this.db.pool, conversationId),
    };
  }
  async feed(agentId: string, query: { before?: number; after?: number; around?: number } = {}) {
    const c = await this.forAgent(agentId);
    const records = (
      await this.db.pool.query(
        `select seq,role,run_id,created_at,md5(content::text) as record_version,(content-'text'-'thinking'-'result') || jsonb_build_object(
        'text',left(content->>'text',2000),'thinking',left(content->>'thinking',2000),
        'result',case when length(content->>'result')>4000 then to_jsonb(left(content->>'result',4000)) else content->'result' end,
        'truncated',coalesce(length(content->>'text'),0)>2000 or coalesce(length(content->>'thinking'),0)>2000 or coalesce(length(content->>'result'),0)>4000,
        'truncatedFields',jsonb_build_object('text',coalesce(length(content->>'text'),0)>2000,'thinking',coalesce(length(content->>'thinking'),0)>2000,'result',coalesce(length(content->>'result'),0)>4000)) as content
       from messages where role<>'model_output' and conversation_id=$1 and ($2::bigint is null or seq<$2) and ($3::bigint is null or seq>$3)
       and ($4::bigint is null or seq>=$4) order by seq ${query.after !== undefined || query.around !== undefined ? "asc" : "desc"} limit 80`,
        [c.id, query.before ?? null, query.after ?? null, query.around ?? null],
      )
    ).rows;
    if (query.after === undefined && query.around === undefined) records.reverse();
    await this.projectToolReceipts(records, c.id, true);
    const bounds = (
      await this.db.pool.query(
        "select exists(select 1 from messages where conversation_id=$1 and seq<$2) as earlier,exists(select 1 from messages where conversation_id=$1 and seq>$3) as later",
        [c.id, records[0]?.seq ?? 0, records.at(-1)?.seq ?? c.message_seq],
      )
    ).rows[0];
    const run = await this.currentRun(c.id);
    const events = records.map((r) => ({
      conversationId: c.id,
      recordVersion: r.record_version,
      seq: Number(r.seq),
      agentId,
      kind: r.role,
      data: r.content,
      createdAt: new Date(r.created_at).toISOString(),
    }));
    // Tool events are persisted in messages by the tool registry, not copied on every read.
    if (
      run?.state === "running" &&
      query.before === undefined &&
      query.after === undefined &&
      query.around === undefined
    ) {
      const live = await new Events(this.db).messageAt(run.id);
      if (live?.streaming)
        events.push({
          conversationId: c.id,
          recordVersion: undefined,
          seq: -1,
          agentId,
          kind: "assistant",
          data: live,
          createdAt: new Date().toISOString(),
        });
    }
    const unknown = await this.unknownTools(c.id);
    return {
      events,
      messageRequests: await conversationRequests(this.db.pool, c.id),
      waits: await listWaits(this.db.pool, c.id),
      conversationId: c.id,
      lastEventSeq: String(run?.last_event_seq ?? "0"),
      context:
        publicContext(c.context) ??
        (await this.context(c.id, (await agentIdentity(this.db.pool, agentId)).config.model).catch(
          () => null,
        )),
      running: run?.state === "running" || run?.state === "queued",
      runId: run?.id,
      runState: run?.state,
      runReason: run?.reason,
      supersededByRunId: run?.superseded_by_run_id ?? null,
      unknownTools: unknown,
      resourceResponse: await resourceResponse(this.db.pool, agentId),
      configurationBlocked:
        c.context?.modelBlocked === true ||
        Boolean(
          (
            await this.db.pool.query(
              "select 1 from schedules where agent_id=$1 and dispatch_state='blocked' and blocked_reason='model_not_configured' limit 1",
              [agentId],
            )
          ).rowCount,
        ),
      interrupted: run?.state === "failed" || run?.state === "cancelled",
      nextBefore: bounds.earlier ? Number(records[0].seq) : null,
      nextAfter: bounds.later ? Number(records.at(-1).seq) : null,
    };
  }
}
