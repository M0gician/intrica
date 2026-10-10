import type { Tx } from "../../adapters/postgres/database.js";
import { appendMessage } from "../execution/messages.js";

/** User and peer inputs share the durable inbox identity and acceptance order. */
export function acceptInput(
  tx: Tx,
  conversationId: string,
  inputId: string,
  role: string,
  content: unknown,
  runId?: string,
) {
  return appendMessage(tx, conversationId, inputId, role, content, runId);
}

/** Caller has checked permissions, task state, cooldown and execution barriers. */
export async function cutoverInput(
  tx: Tx,
  conversationId: string,
  inputId: string,
  runId: string | null,
  agentInitiated: boolean,
) {
  await tx.query(
    `update conversations set generation=generation+1,
    last_agent_expedite_at=case when $2 then now() else last_agent_expedite_at end where id=$1`,
    [conversationId, agentInitiated],
  );
  const request =
    (
      await tx.query(
        "update inference_requests set state='cutting' where conversation_id=$1 and state in('prepared','streaming') returning id",
        [conversationId],
      )
    ).rows[0] ??
    (
      await tx.query(
        "select id from inference_requests where conversation_id=$1 and state in('cutting','settling') order by created_at desc limit 1",
        [conversationId],
      )
    ).rows[0];
  if (request)
    await tx.query(
      "update inference_attempts set state='cutting',cutover_at=clock_timestamp() where request_id=$1 and state in('prepared','streaming')",
      [request.id],
    );
  await tx.query(
    `update messages set expedite_requested_at=now(),expedite_run_id=$3,cutover_request_id=$5,
    content=case when $4 then content else content-'activationBlocked' end
    where conversation_id=$1 and client_message_id=$2`,
    [conversationId, inputId, runId, agentInitiated, request?.id ?? null],
  );
}
