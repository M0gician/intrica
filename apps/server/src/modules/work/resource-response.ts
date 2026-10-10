import { type Database, DomainError, digest, id } from "../../adapters/postgres/database.js";
import { agentIdentity } from "../access/policy.js";
import { resourceResponse, scheduleChanged } from "../execution/schedules.js";

/** An owner retry retains the source identity and its automatic activation budget. */
export async function retryResourceResponse(
  db: Database,
  agentId: string,
  revision: string,
  key: string,
) {
  const { canvas_id: canvasId } = await agentIdentity(db.pool, agentId);
  return db.canvas(canvasId, async (tx) => {
    const hash = digest({ kind: "resource_response.retry", agentId, revision });
    const prior = (
      await tx.query(
        "select request_hash,response from commands where canvas_id=$1 and actor_id='owner' and command_key=$2",
        [canvasId, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== hash)
        throw new DomainError("IDEMPOTENCY_CONFLICT", "请求键已用于不同操作");
      return prior.response;
    }
    const identity = await agentIdentity(tx, agentId);
    if (!identity.enabled) throw new DomainError("INVALID_STATE", "请先开启持续协作");
    const current = await resourceResponse(tx, agentId);
    if (!current || current.revision !== revision)
      throw new DomainError("VERSION_CONFLICT", "资源响应状态已变化，请刷新后重试");
    if (current.state !== "blocked")
      throw new DomainError("INVALID_STATE", "只有受阻的资源响应可以重试");
    const { rows } = await tx.query(
      `update schedules set enabled=true,dispatch_state='pending',blocked_reason=null,
       next_due_at=clock_timestamp(),revision=revision+1 where agent_id=$1 and kind='resource_change'
       and revision=$2 and dispatch_state='blocked' returning *`,
      [agentId, revision],
    );
    await scheduleChanged(tx, rows);
    const response = { resourceResponse: await resourceResponse(tx, agentId) };
    await tx.query(
      "insert into commands(id,canvas_id,actor_id,command_key,request_hash,response,kind) values($1,$2,'owner',$3,$4,$5,'resource_response.retry')",
      [id("command"), canvasId, key, hash, JSON.stringify(response)],
    );
    return response;
  });
}
