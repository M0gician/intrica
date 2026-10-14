/** Trusted SQL expressions only; all surfaces project the same safe request fields. */
export function modelRequestProjection(runExpression: string) {
  return `(select jsonb_build_object('requestId',mr.id,'state',mr.state,'reason',mr.reason,'attempts',mr.attempts,
    'nextAttemptAt',case when mr.state in('retry_wait','failed') then greatest(mr.next_attempt_at,q.cooldown_until,mr.lease_until)
      when mr.state='queued' and q.cooldown_until>now() then q.cooldown_until else null end)
    from model_requests mr join model_quota_groups q on q.id=mr.group_id
    where mr.run_id=${runExpression} order by mr.created_at desc,mr.id desc limit 1)`;
}
