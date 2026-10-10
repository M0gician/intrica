import { canvasEvent, DomainError, type Tx } from "../../adapters/postgres/database.js";

export async function retainDependency(tx: Tx, parentId: string, childId: string) {
  const cycle = await tx.query(
    `with recursive descendants(id) as (select $2::text union
      select d.child_id from request_dependencies d join descendants a on d.parent_id=a.id where d.released_at is null)
    select 1 from descendants where id=$1`,
    [parentId, childId],
  );
  if (cycle.rowCount) throw new DomainError("VALIDATION", "任务不能等待自身或形成循环依赖");
  await tx.query(
    `insert into request_dependencies(parent_id,child_id) values($1,$2)
    on conflict(parent_id,child_id) do update set released_at=null`,
    [parentId, childId],
  );
}

/** Release ownership, then close only exclusive children with no live owner. */
export async function releaseDependencies(tx: Tx, parentIds: string[], reason: string) {
  const visited = new Set<string>();
  let pending = parentIds;
  while (pending.length) {
    const parents = pending.filter((id) => !visited.has(id));
    if (!parents.length) break;
    for (const id of parents) visited.add(id);
    await tx.query(
      `update message_waits set state='cancelled',release_reason=$2,released_at=now()
      where work_item_id=any($1::text[]) and state='active'`,
      [parents, reason],
    );
    const children = (
      await tx.query(
        `update request_dependencies set released_at=now()
      where parent_id=any($1::text[]) and released_at is null returning child_id`,
        [parents],
      )
    ).rows;
    const closed = (
      await tx.query(
        `update message_requests r set state='cancelled',work_state='closed',
      blocked_reason=$2,version=version+1,updated_at=now()
      where id=any($1::text[]) and state='open' and lifetime='exclusive'
      and not exists(select 1 from request_dependencies d join message_requests p on p.id=d.parent_id
        where d.child_id=r.id and d.released_at is null and p.state='open' and p.work_state<>'stopped')
      returning *`,
        [children.map((r) => r.child_id), reason],
      )
    ).rows;
    pending = closed.map((r) => r.id);
    if (!pending.length) continue;
    await tx.query(
      `update messages set content=content||'{"closed":true}'::jsonb
      where content->>'workItemId'=any($1::text[]) and consumed_run_id is null`,
      [pending],
    );
    await tx.query(
      `update message_dispatches set state='cancelled',updated_at=now()
      where work_item_id=any($1::text[]) and state in('prepared','waiting')`,
      [pending],
    );
    // Keep dispatched calls and their receipts. Their effects must never be replayed.
    await tx.query(
      `update tool_calls set state='failed',result=jsonb_build_object('content',
      jsonb_build_array(jsonb_build_object('type','text','text','Task closed before execution')),
      'details',jsonb_build_object('executed',false,'reason',$2::text),'isError',true)
      where work_item_id=any($1::text[]) and state in('prepared','waiting')`,
      [pending, reason],
    );
    await tx.query(
      `update approvals set status='cancelled',version=version+1,decided_at=now()
      where status='pending' and (origin_call_id in(select id from tool_calls where work_item_id=any($1::text[]))
      or origin_dispatch_id in(select id from message_dispatches where work_item_id=any($1::text[])))`,
      [pending],
    );
    await tx.query(
      `update conversations set generation=generation+1
      where context->>'workItemId'=any($1::text[])`,
      [pending],
    );
    // Release a now-empty waiting run; leave running effects and other work alone.
    await tx.query(
      `update runs r set state='cancelled',reason='request_closed',updated_at=now()
      where r.state in('queued','waiting') and r.kind='conversation'
      and r.subject_id=any($1::text[]) and r.reason is distinct from 'tool_contract_upgrade'
      and not exists(select 1 from tool_calls t where t.run_id=r.id and t.state in('dispatching','unknown'))
      and not exists(select 1 from message_requests w where w.recipient_conversation_id=r.subject_id and w.state='open' and w.work_state<>'stopped')
      and not exists(select 1 from messages m where m.conversation_id=r.subject_id and m.consumed_run_id is null
        and m.content->>'closed' is distinct from 'true' and m.role in('user','message','trigger','tool_update'))`,
      [closed.map((r) => r.recipient_conversation_id)],
    );
    for (const child of closed)
      await canvasEvent(tx, child.canvas_id, "conversation.changed", {
        conversationId: child.recipient_conversation_id,
        collaborationRequestId: child.id,
      });
  }
}
