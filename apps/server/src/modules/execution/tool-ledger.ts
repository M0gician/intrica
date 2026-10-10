import { digest, id, type Tx } from "../../adapters/postgres/database.js";
import type { ExecutionTool } from "./tool-calls.js";
import { result, type ToolResult } from "./tool-results.js";
import type { ToolInputError } from "./tool-validation.js";
import type { ExecutionContext } from "./worker.js";

export type ToolObservation = {
  generationId?: string;
  providerCallId?: string;
  contentIndex?: number;
  observationId?: string;
  parseError?: string;
  workItemId?: string | null | undefined;
  decisionRevision?: number;
  inferenceItemId?: string;
};

export async function recordInvocation(
  tx: Tx,
  ctx: ExecutionContext,
  input: {
    name: string;
    logicalId: string;
    args: unknown;
    hash: string;
    schemaVersion: number;
    definition?: ExecutionTool | undefined;
    observation?: ToolObservation | undefined;
  },
) {
  const callId = id("tool");
  const workItemId =
    input.observation && Object.hasOwn(input.observation, "workItemId")
      ? (input.observation.workItemId ?? null)
      : (ctx.run.frozen_input.workItemId ?? null);
  const model = input.observation?.generationId
    ? (
        await tx.query(
          "select id from model_calls where generation_id=$1 and run_id=$2 order by started_at desc,id desc limit 1",
          [input.observation.generationId, ctx.run.id],
        )
      ).rows[0]
    : null;
  const previous = (
    await tx.query(
      `select t.id from tool_calls t join runs r on r.id=t.run_id
     where r.subject_id=$1 and t.name=$2 and t.work_item_id is not distinct from $3
     and ($3::text is not null or t.run_id=$4) and t.state='failed'
     and t.audit->>'inputError'='true' order by t.created_at desc,t.id desc limit 1`,
      [ctx.run.subject_id, input.name, workItemId, ctx.run.id],
    )
  ).rows[0];
  await tx.query(
    `insert into tool_calls(id,run_id,attempt_id,logical_call_id,name,args,args_hash,effect_class,state,work_item_id,generation,audit,retry_of,model_call_id,observation_id,inference_item_id)
     values($1,$2,$3,$4,$5,$6,$7,$8,'prepared',$9,$10,$11,$12,$13,$14,$15)`,
    [
      callId,
      ctx.run.id,
      ctx.run.attemptId,
      input.logicalId,
      input.name,
      JSON.stringify(input.args ?? null),
      input.hash,
      input.definition?.effect ?? "none",
      workItemId,
      input.observation?.decisionRevision ?? ctx.run.frozen_input.generation ?? null,
      JSON.stringify({
        phase: input.observation?.parseError ? "parse" : "validation",
        executed: false,
        schemaVersion: input.schemaVersion,
        ...(input.definition
          ? {
              executionSchemaHash: digest(input.definition.parameters),
              discoverySchemaHash: digest(
                input.definition.modelParameters ?? input.definition.parameters,
              ),
              parallel: input.definition.effect === "read" && input.definition.parallel === true,
            }
          : {}),
        ...input.observation,
        parseError: undefined,
      }),
      previous?.id ?? null,
      model?.id ?? null,
      input.observation?.observationId ?? null,
      input.observation?.inferenceItemId ?? null,
    ],
  );
  return callId;
}

export async function rejectInput(
  tx: Tx,
  ctx: ExecutionContext,
  callId: string,
  error: ToolInputError,
): Promise<ToolResult> {
  const workItemId = (await tx.query("select work_item_id from tool_calls where id=$1", [callId]))
    .rows[0].work_item_id;
  const prior = (
    await tx.query(
      `select count(*)::int as count from tool_calls t join runs r on r.id=t.run_id
     where r.subject_id=$1 and t.work_item_id is not distinct from $2
       and ($2::text is not null or t.run_id=$3) and t.id<>$4 and t.audit->>'errorFingerprint'=$5
       and t.created_at > coalesce((select max(s.completed_at) from tool_calls s join runs sr on sr.id=s.run_id
         where sr.subject_id=$1 and s.name=t.name and s.work_item_id is not distinct from $2 and s.state='succeeded'),'-infinity')`,
      [ctx.run.subject_id, workItemId, ctx.run.id, callId, error.fingerprint],
    )
  ).rows[0].count;
  const repairsRemaining = Math.max(0, ctx.store.limits.toolInputRepairs - Number(prior));
  const blocked = repairsRemaining === 0;
  const audit = {
    phase: error.phase,
    executed: false,
    inputError: true,
    errorFingerprint: error.fingerprint,
    errorCode: error.code,
    repairsRemaining,
    blocked,
  };
  const output: ToolResult = {
    ...result({
      ...error,
      callId,
      repairsRemaining,
      ...(blocked
        ? {
            blockedReason: "tool_input",
            nextAction:
              "This work item needs corrected input. Continue independent work or report the blocked request; do not repeat the failed call.",
          }
        : {}),
    }),
    isError: true,
    details: { invocation: audit },
    ...(blocked ? { control: { waiting: "tool_input" as const } } : {}),
  };
  await tx.query(
    "update tool_calls set state='failed',result=$2,audit=audit||$3::jsonb,completed_at=now(),updated_at=now() where id=$1",
    [callId, JSON.stringify(output), JSON.stringify(audit)],
  );
  return output;
}

export async function invocationStage(
  tx: Tx,
  callId: string,
  phase: string,
  executed: boolean,
  errorCode?: string,
) {
  await tx.query("update tool_calls set audit=audit||$2::jsonb where id=$1", [
    callId,
    JSON.stringify({ phase, executed, errorCode: errorCode ?? null }),
  ]);
}
