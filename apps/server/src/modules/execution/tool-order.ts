import type { Tx } from "../../adapters/postgres/database.js";
import type { ExecutionTool } from "./tool-calls.js";

/** Calls that depend on an earlier effect wait on its existing receipt. */
export async function deferTool(tx: Tx, callId: string, tool: ExecutionTool) {
  if (tool.coordination) return false;
  const pending = (
    await tx.query(
      `select 1 from tool_calls prior join tool_calls current on current.id=$1
    where prior.run_id=current.run_id and prior.work_item_id is not distinct from current.work_item_id
    and (prior.created_at,prior.id)<(current.created_at,current.id)
    and prior.state in('prepared','dispatching')
    and ($2=false or prior.audit->>'parallel' is distinct from 'true') limit 1`,
      [callId, tool.effect === "read" && tool.parallel === true],
    )
  ).rowCount;
  if (!pending) return false;
  await tx.query(
    'update tool_calls set is_async=true,audit=audit||\'{"phase":"dependency","executed":false}\' where id=$1',
    [callId],
  );
  return true;
}
