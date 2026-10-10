import {
  closeCheckpointCall,
  matchCheckpointCall,
  openCheckpointCalls,
} from "../../../modules/execution/checkpoint-tools.js";
import { appendMessage } from "../../../modules/execution/messages.js";
import { result } from "../../../modules/execution/tool-calls.js";
import type { Tx } from "../database.js";

/** Retire pending old communication, retain history, and classify only unread user input. */
export async function migrateAddressedMessages(tx: Tx) {
  await tx.query(`insert into message_requests(id,canvas_id,message_id,sender_kind,sender_conversation_id,
    recipient_kind,recipient_conversation_id,recipient_agent_id)
    select 'request-'||md5(m.conversation_id||':'||m.seq::text),c.canvas_id,
      'user-'||m.conversation_id||'-'||m.client_message_id,'user',c.id,c.identity_kind,c.id,c.agent_id
    from messages m join conversations c on c.id=m.conversation_id where m.role='user'
      and m.consumed_run_id is null and m.seq>c.consumed_message_seq and c.identity_kind<>'deleted_agent'
      and m.content->>'closed' is distinct from 'true'`);
  await tx.query(`update messages m set content=m.content||jsonb_build_object('workItemId',q.id,'collaborationRequestId',q.id)
    from message_requests q where q.sender_kind='user' and q.sender_conversation_id=m.conversation_id
    and q.message_id='user-'||m.conversation_id||'-'||m.client_message_id`);
  const rows = (await tx.query("select id,checkpoint,context from conversations")).rows;
  for (const row of rows) {
    const calls = (
      await tx.query(
        "select t.* from tool_calls t join runs r on r.id=t.run_id where r.subject_id=$1 and t.name in('send_message','report_result')",
        [row.id],
      )
    ).rows;
    const failure = {
      ...result(
        "The message protocol changed. This pending message was not sent. Use the explicit target contract for future messages.",
      ),
      isError: true,
    };
    const pending = calls.filter((c) => ["prepared", "waiting", "dispatching"].includes(c.state));
    for (const call of pending) {
      await tx.query(
        "update tool_calls set state='failed',result=$2,delivered_at=null,updated_at=now() where id=$1",
        [call.id, JSON.stringify(failure)],
      );
      await tx.query(
        "update approvals set status='invalidated',version=version+1,decided_at=now() where origin_call_id=$1 and status='pending'",
        [call.id],
      );
    }
    let changed = pending.length > 0;
    for (const entry of openCheckpointCalls(row.checkpoint).reverse()) {
      const call = entry;
      if (!["send_message", "report_result"].includes(call.name)) continue;
      const stored = matchCheckpointCall(
        entry,
        calls,
        row.context?.pendingTurnId,
        row.checkpoint.findLastIndex((m: any) => m.role === "assistant"),
      );
      const receipt =
        stored && ["succeeded", "failed"].includes(stored.state)
          ? (stored.result ?? result("This message already has a historical execution receipt."))
          : failure;
      closeCheckpointCall(
        row.checkpoint,
        entry,
        receipt,
        stored?.id ?? `retired-${entry.id}`,
        Boolean(receipt.isError),
      );
      changed = true;
    }
    if (changed) {
      await tx.query("update conversations set checkpoint=$2,generation=generation+1 where id=$1", [
        row.id,
        JSON.stringify(row.checkpoint),
      ]);
      await tx.query(
        "update runs set state='waiting',reason='tool_contract_upgrade',owner_id=null,lease_until=null where subject_id=$1 and state in('queued','running','waiting')",
        [row.id],
      );
      await appendMessage(tx, row.id, "message-protocol-upgrade", "status", {
        reason: "tool_contract_upgrade",
        text: "消息协议已更新。旧的待发送消息已关闭，历史记录保持原样。",
      });
    }
  }
}
