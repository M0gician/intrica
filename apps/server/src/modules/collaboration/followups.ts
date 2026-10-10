import { DomainError, type Tx } from "../../adapters/postgres/database.js";

export const followupLimit = () => {
  const value = Number(process.env.INTRICA_MESSAGE_FOLLOWUPS ?? 1);
  return Number.isInteger(value) ? Math.max(0, Math.min(20, value)) : 1;
};

/** A followup reuses the request and its original recipient. It never creates work. */
export async function recordFollowup(
  tx: Tx,
  requestId: string,
  dispatchId: string,
  conversationId: string,
) {
  const request = (await tx.query("select * from message_requests where id=$1", [requestId]))
    .rows[0];
  if (request.state !== "open" || request.work_state === "stopped")
    throw new DomainError("REQUEST_CLOSED", "此请求已结束或停止");
  if (Number(request.followup_count) >= followupLimit())
    throw new DomainError("FOLLOWUP_LIMIT", "已达到此请求的自动跟进上限，请等待回复或报告阻塞");
  const window =
    (
      await tx.query(
        `select id from message_waits where conversation_id=$1 and $2=any(request_ids)
    order by created_at desc,id desc limit 1`,
        [conversationId, requestId],
      )
    ).rows[0]?.id ?? "initial";
  const recorded = await tx.query(
    `insert into message_followups(request_id,message_id,wait_window)
    values($1,$2,$3) on conflict do nothing returning request_id`,
    [requestId, dispatchId, window],
  );
  if (!recorded.rowCount) throw new DomainError("FOLLOWUP_LIMIT", "当前等待窗口已发送过跟进消息");
  await tx.query("update message_requests set followup_count=followup_count+1 where id=$1", [
    requestId,
  ]);
}
