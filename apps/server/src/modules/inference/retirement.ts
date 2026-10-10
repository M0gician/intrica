import type { Tx } from "../../adapters/postgres/database.js";

/** Stop and takeover seal the transport lifetime while retaining committed history. */
export async function retireInference(tx: Tx, conversationIds: string[], reason: string) {
  const requests = (
    await tx.query(
      "update inference_requests set state='sealed',reason=$2,sealed_at=clock_timestamp() where conversation_id=any($1::text[]) and state<>'sealed' returning id",
      [conversationIds, reason],
    )
  ).rows;
  if (!requests.length) return;
  const attempts = (
    await tx.query(
      "update inference_attempts set state='sealed',outcome=$2,sealed_at=clock_timestamp() where request_id=any($1::text[]) and state<>'sealed' returning id",
      [requests.map((r) => r.id), reason],
    )
  ).rows;
  const items = (
    await tx.query(
      "update inference_items set state='discarded',version=version+1,updated_at=now() where attempt_id=any($1::text[]) and state in('streaming','closed') returning id,version",
      [attempts.map((r) => r.id)],
    )
  ).rows;
  for (const item of items)
    await tx.query(
      "update messages set content=content||jsonb_build_object('state','discarded','version',$3::int) where conversation_id=any($1::text[]) and client_message_id=$2",
      [conversationIds, `inference-item-${item.id}`, item.version],
    );
}
