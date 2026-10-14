import { digest, type Sql } from "../../../adapters/postgres/database.js";

/** Delivery after review is allowed; newly performed work still needs verification. */
export async function progressExecutionState(sql: Sql, runId: string) {
  const rows = (
    await sql.query(
      `select id,name,state,args_hash from tool_calls where run_id=$1
     and name not in ('review_progress','read_inbox','update_message')
     and not (name='send_message' and state='succeeded') order by id`,
      [runId],
    )
  ).rows;
  return {
    hash: digest(rows),
    pending: rows
      .filter((r) => ["prepared", "dispatching", "waiting", "unknown"].includes(r.state))
      .map(({ id, name, state }) => ({ id, name, state })),
  };
}
