import { type Database, DomainError } from "../../adapters/postgres/database.js";
import { actionableMessage, currentTeamNotice } from "../execution/messages.js";
import { type CanvasMessagePage, CanvasMessages } from "./canvas-messages.js";

type ActivityFilter = { selection?: string[] | undefined; groupId?: string | undefined };
export class Activity {
  readonly messages: CanvasMessages;
  constructor(readonly db: Database) {
    this.messages = new CanvasMessages(db);
  }
  async inspect(canvasId: string, agentIds: string[]) {
    const ids = [...new Set(agentIds)];
    if (!ids.length || agentIds.length > 40)
      throw new DomainError("VALIDATION", "一次可查询 1–40 个 Agent");
    const rows = (
      await this.db.pool.query(
        `
      select n.id,n.body->>'title' as title,a.enabled,parent.node_id as manager_id,
        (select coalesce(jsonb_agg(jsonb_build_object('id',w.id,'mode',w.mode,'requestIds',w.request_ids,'deadline',w.deadline,'blockedReason',w.blocked_reason)), '[]'::jsonb) from message_waits w where w.conversation_id=c.id and w.state='active') as message_waits,
        r.id as run_id,r.state,r.reason,r.cancel_requested_at,r.updated_at,r.superseded_by_run_id,
        (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'reviewerId',p.assigned_reviewer_id,'kind',p.action->>'kind','expiresAt',p.expires_at)), '[]'::jsonb) from approvals p where p.subject_id=n.id and p.status='pending') as pending_requests,
        (select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'elapsedSeconds',greatest(0,extract(epoch from now()-t.updated_at)::int))), '[]'::jsonb) from tool_calls t where t.run_id=r.id and t.state='dispatching') as active_tools,
        (select count(*)::int from messages m where m.conversation_id=c.id and m.consumed_run_id is null and (m.seq>c.consumed_message_seq or m.content->>'workItemId' is not null) and m.content->>'closed' is distinct from 'true'
          and (${actionableMessage} or ${currentTeamNotice} or (m.role='message' and m.content ? 'from' and not(m.content ? 'activationBlocked')))) as pending_messages,
        (select count(*)::int from messages m where m.conversation_id=c.id and m.consumed_run_id is null and (m.seq>c.consumed_message_seq or m.content->>'workItemId' is not null) and m.content->>'closed' is distinct from 'true'
          and m.role in('message','team_notice') and m.content ? 'activationBlocked') as blocked_messages
      from nodes n join agent_configs a on a.node_id=n.id
      join canvases board on board.id=n.canvas_id and board.deleted_at is null
      left join agent_configs parent on parent.node_id=n.parent_id
      left join conversations c on c.agent_id=n.id
      left join lateral (select id,state,reason,cancel_requested_at,updated_at,superseded_by_run_id from runs
        where subject_id=c.id order by created_at desc,id desc limit 1) r on true
      where n.canvas_id=$1 and n.id=any($2::text[]) order by n.id`,
        [canvasId, ids],
      )
    ).rows;
    if (rows.length !== ids.length)
      throw new DomainError("NOT_FOUND", "Agent 不存在或不在当前画布");
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      enabled: r.enabled,
      activationMode: r.enabled ? "on_change" : "on_demand",
      // Stopping a run does not close a live Agent's mailbox. Sender authority
      // and activation budgets are checked separately when a message is sent.
      canReceiveMessages: true,
      managerId: r.manager_id,
      runId: r.run_id ?? null,
      supersededByRunId: r.superseded_by_run_id ?? null,
      runState: r.state ?? "idle",
      waitReason:
        r.state === "running" && r.reason === "background"
          ? "background"
          : r.state === "waiting" &&
              [
                "message",
                "approval",
                "unknown",
                "turn_limit",
                "tool_input",
                "reply_required",
                "message_protocol",
              ].includes(r.reason)
            ? r.reason
            : null,
      cancelRequested: Boolean(r.cancel_requested_at),
      updatedAt: r.updated_at ?? null,
      pendingMessages: r.pending_messages,
      blockedMessages: r.blocked_messages,
      pendingRequests: r.pending_requests,
      activeTools: r.active_tools,
      waits: r.message_waits,
    }));
  }

  private async scope(canvasId: string, filter: ActivityFilter) {
    const agents = (
      await this.db.pool.query(
        `select a.node_id as id,n.body->>'title' as title,parent_agent.node_id as manager_id,c.message_seq,
      (select state from runs r where r.subject_id=c.id order by created_at desc limit 1) as state,
      (select reason from runs r where r.subject_id=c.id order by created_at desc limit 1) as reason
      from agent_configs a join nodes n on n.id=a.node_id left join agent_configs parent_agent on parent_agent.node_id=n.parent_id left join conversations c on c.agent_id=a.node_id where n.canvas_id=$1`,
        [canvasId],
      )
    ).rows;
    const team = (roots: string[]) => {
      const ids = new Set(roots);
      let changed = true;
      while (changed) {
        changed = false;
        for (const a of agents)
          if (!ids.has(a.id) && ids.has(a.manager_id)) {
            ids.add(a.id);
            changed = true;
          }
      }
      return [...ids];
    };
    const selection = filter.selection?.length ? team(filter.selection) : null;
    const group = filter.groupId ? team([filter.groupId]) : null;
    return { agents, selection, group, team };
  }
  async navigation(canvasId: string, filter: ActivityFilter, after?: string) {
    const { selection, group } = await this.scope(canvasId, filter);
    return this.messages.index([canvasId, selection, group], after);
  }
  async preview(canvasId: string, filter: ActivityFilter, key: string) {
    const { selection, group } = await this.scope(canvasId, filter);
    return this.messages.preview([canvasId, selection, group], key);
  }
  async board(
    canvasId: string,
    summary = false,
    filter: ActivityFilter = {},
    page: CanvasMessagePage = {},
  ) {
    const { agents, selection, group, team } = await this.scope(canvasId, filter);
    const messages = summary
      ? { events: [], nextBefore: null, nextAfter: null }
      : await this.messages.page([canvasId, selection, group], page);
    const revision =
      (await this.db.pool.query("select graph_revision from canvases where id=$1", [canvasId]))
        .rows[0]?.graph_revision ?? 0;
    return {
      graphRevision: revision,
      agents: agents.map((a) => ({
        id: a.id,
        status:
          a.state === "running" && a.reason === "background"
            ? "waiting"
            : a.state === "running" || a.state === "queued"
              ? "working"
              : a.state === "waiting"
                ? "waiting"
                : a.state === "failed"
                  ? "error"
                  : "idle",
        seq: Number(a.message_seq ?? 0),
        messageSeq: Number(a.message_seq ?? 0),
        managerId: a.manager_id,
        waitReason: a.state === "waiting" || a.reason === "background" ? a.reason : null,
      })),
      ...messages,
      groups: agents
        .filter((a) => agents.some((c) => c.manager_id === a.id))
        .map((a) => ({
          id: a.id,
          title: a.title || "Agent Team",
          agentIds: team([a.id]),
        })),
    };
  }
}
