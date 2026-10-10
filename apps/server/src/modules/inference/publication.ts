import type { Tx } from "../../adapters/postgres/database.js";

/** Delivery annotates diagnostics; it never rewrites committed model history. */
export async function recordPublication(
  tx: Tx,
  dispatch: any,
  receipt: { internal?: boolean; delivered?: number },
) {
  const publication = {
    messageId: dispatch.id,
    state: receipt.internal ? "internal" : receipt.delivered ? "sent" : "empty",
  };
  const rows = (
    await tx.query(
      `update inference_items i set publication=$2::jsonb from inference_attempts a
    where i.attempt_id=a.id and i.state='committed'
    and a.request_id in(select id from inference_requests where conversation_id=$1) and (
      ($3='final' and a.request_id=$4 and i.kind='text') or
      ($3='tool' and i.id=(select inference_item_id from tool_calls where id=$5))) returning i.id`,
      [
        dispatch.conversation_id,
        JSON.stringify(publication),
        dispatch.origin,
        dispatch.logical_id.slice("final:".length),
        dispatch.tool_call_id,
      ],
    )
  ).rows;
  for (const row of rows)
    await tx.query(
      "update messages set content=content||jsonb_build_object('publication',$3::jsonb) where conversation_id=$1 and client_message_id=$2",
      [dispatch.conversation_id, `inference-item-${row.id}`, JSON.stringify(publication)],
    );
}
