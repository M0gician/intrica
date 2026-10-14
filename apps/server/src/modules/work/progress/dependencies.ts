import type { Sql } from "../../../adapters/postgres/database.js";

/** Only persisted conditions capable of waking this conversation are offered. */
export async function wakeDependencies(sql: Sql, conversationId: string) {
  const schedules = (
    await sql.query(
      `select s.id,s.next_due_at as "nextDueAt" from schedules s join conversations c on c.agent_id=s.agent_id
     where c.id=$1 and s.enabled and s.dispatch_state='pending' order by s.next_due_at limit 40`,
      [conversationId],
    )
  ).rows.map((row) => ({ ...row, kind: "schedule" }));
  const background = (
    await sql.query(
      `select t.id,t.name from tool_calls t join runs r on r.id=t.run_id where r.subject_id=$1
     and r.state='running' and t.is_async and t.state in ('prepared','dispatching') order by t.created_at limit 40`,
      [conversationId],
    )
  ).rows.map((row) => ({ ...row, kind: "tool" }));
  return [...schedules, ...background];
}
