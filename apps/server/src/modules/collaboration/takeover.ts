import type { Tx } from "../../adapters/postgres/database.js";
import { appendMessage } from "../execution/messages.js";
import type { Run } from "../execution/store.js";

/** Move reply responsibility for the selected work, never an Agent's checkpoint. */
export async function transferRequests(tx: Tx, source: Run, receiver: Run) {
  const c = (await tx.query("select context from conversations where id=$1", [source.subject_id]))
    .rows[0];
  const workItemId = c?.context?.workItemId ?? source.frozen_input.workItemId;
  await tx.query("update conversations set generation=generation+1 where id=$1", [
    source.subject_id,
  ]);
  await tx.query(
    "update message_dispatches set state='cancelled',updated_at=now() where run_id=$1 and state in('prepared','waiting')",
    [source.id],
  );
  if (!workItemId) return [];
  const moved = (
    await tx.query(
      `update message_requests set recipient_conversation_id=$2,recipient_agent_id=$3,
    recipient_kind='agent',takeover_run_id=$4,work_state='queued',blocked_reason=null,version=version+1,updated_at=now()
    where id=$1 and recipient_conversation_id=$5 and state='open' returning *`,
      [
        workItemId,
        receiver.subject_id,
        receiver.frozen_input.agentId,
        source.id,
        source.subject_id,
      ],
    )
  ).rows;
  if (!moved.length) return [];
  await tx.query(
    `update message_waits set conversation_id=$2,run_id=$3,generation=c.generation,
    baseline_seq=c.consumed_message_seq from conversations c where c.id=$2 and work_item_id=$1 and state='active'`,
    [workItemId, receiver.subject_id, receiver.id],
  );
  // Children return to the new responsible executor. Their parent work ID stays stable.
  await tx.query(
    `update message_requests set sender_conversation_id=$2,sender_agent_id=$3,sender_kind='agent',
    version=version+1,updated_at=now() where origin_work_item_id=$1 and sender_conversation_id=$4 and state='open'`,
    [workItemId, receiver.subject_id, receiver.frozen_input.agentId, source.subject_id],
  );
  const original = (
    await tx.query(
      "select content from messages where conversation_id=$1 and content->>'collaborationRequestId'=$2 order by seq limit 1",
      [source.subject_id, workItemId],
    )
  ).rows[0];
  await appendMessage(
    tx,
    receiver.subject_id,
    `takeover-input-${source.id}`,
    "message",
    {
      text:
        original?.content?.text ??
        "Continue the taken-over request. Review the source run before executing work.",
      from: source.frozen_input.agentId,
      senderConversationId: source.subject_id,
      workItemId,
      collaborationRequestId: workItemId,
      sourceRunId: source.id,
      causeId: moved[0].cause_id ?? source.cause_id,
    },
    receiver.id,
  );
  return moved.map((r) => r.id as string);
}
