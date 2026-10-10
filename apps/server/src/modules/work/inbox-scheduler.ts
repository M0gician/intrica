import {
  canvasEvent,
  type Database,
  DomainError,
  digest,
} from "../../adapters/postgres/database.js";
import { escalateApproval } from "../access/lifecycle.js";
import { agentIdentity } from "../access/policy.js";
import { pendingInboxMessage } from "../execution/messages.js";
import type { Conversations } from "./conversations.js";

export class InboxScheduler {
  private inboxCursor = "";
  constructor(
    readonly db: Database,
    readonly conversations: Conversations,
  ) {}
  async maintain() {
    // The inbox is the durable queue. Rotate the bounded scan even when a model
    // is unavailable, so one broken page cannot starve the next one.
    const eligible = pendingInboxMessage;
    const candidates = (cursor: string) =>
      this.db.pool.query(
        `
      select c.id,c.canvas_id,c.agent_id,c.identity_kind,c.model as saved_model,cfg.config from conversations c
      left join agent_configs cfg on cfg.node_id=c.agent_id join canvases board on board.id=c.canvas_id
      where board.deleted_at is null and c.identity_kind<>'deleted_agent' and c.context->>'modelBlocked' is distinct from 'true'
      and exists(select 1 from messages m where m.conversation_id=c.id and m.consumed_run_id is null and (m.seq>c.consumed_message_seq or m.content->>'workItemId' is not null) and m.run_id is null and ${eligible})
      and not exists(select 1 from runs r where r.subject_id=c.id and r.state in('queued','running','waiting'))
      order by (c.id<=$1),c.id limit 128`,
        [cursor],
      );
    const inboxes = (await candidates(this.inboxCursor)).rows;
    this.inboxCursor = inboxes.at(-1)?.id ?? "";
    for (const c of inboxes) {
      try {
        const model = await this.conversations.models.capture(
          c.agent_id ? c.config.model : c.saved_model,
        );
        await this.db.canvas(c.canvas_id, async (tx) => {
          if (c.agent_id) {
            const identity = await agentIdentity(tx, c.agent_id);
            if (digest(identity.config) !== digest(c.config)) return;
          } else {
            const live = (
              await tx.query("select identity_kind,model from conversations where id=$1", [c.id])
            ).rows[0];
            if (live?.identity_kind !== "workspace" || digest(live.model) !== digest(c.saved_model))
              return;
          }
          if (
            (
              await tx.query(
                "select 1 from runs where subject_id=$1 and state in('queued','running','waiting')",
                [c.id],
              )
            ).rowCount
          )
            return;
          // Recheck after acquiring the canvas lock: Stop may have consumed the
          // inbox, or another maintainer may already have assigned these messages.
          const groups = (
            await tx.query(
              `select m.content->>'causeId' as cause_id,min(m.seq) as first_seq
            from messages m join conversations c on c.id=m.conversation_id
            where c.id=$1 and m.consumed_run_id is null and (m.seq>c.consumed_message_seq or m.content->>'workItemId' is not null) and m.run_id is null and ${eligible}
            group by m.content->>'causeId' order by min(m.seq) limit 128`,
              [c.id],
            )
          ).rows;
          for (const group of groups) {
            try {
              await this.conversations.runs.enqueue(tx, {
                ...(group.cause_id ? { causeId: group.cause_id } : {}),
                canvasId: c.canvas_id,
                subjectId: c.id,
                kind: "conversation",
                frozen: {
                  conversationId: c.id,
                  agentId: c.agent_id,
                  selection: [],
                  model,
                  language: await this.conversations.language(c.id, tx),
                },
              });
            } catch (error) {
              if (!(error instanceof DomainError) || error.code !== "LIMIT_REACHED") throw error;
              await tx.query(
                `update messages set content=content||'{"activationBlocked":true}'::jsonb
                where conversation_id=$1 and run_id is null and consumed_run_id is null and content->>'closed' is distinct from 'true'
                and role in ('message','team_notice') and content->>'causeId' is not distinct from $2`,
                [c.id, group.cause_id],
              );
              continue;
            }
            break;
          }
        });
      } catch (error) {
        if (error instanceof DomainError && error.code === "QUEUE_FULL") continue;
        await this.db.canvas(c.canvas_id, async (tx) => {
          if (error instanceof DomainError && error.code === "MODEL_NOT_CONFIGURED") {
            await tx.query(
              "update message_requests set blocked_reason='model_not_configured' where recipient_conversation_id=$1 and state='open'",
              [c.id],
            );
            await tx.query(
              "update conversations set context=coalesce(context,'{}')||'{\"modelBlocked\":true}'::jsonb where id=$1",
              [c.id],
            );
            await canvasEvent(tx, c.canvas_id, "conversation.changed", {
              conversationId: c.id,
              agentId: c.agent_id,
            });
          }
          const rows = (
            await tx.query(
              "select * from approvals where assigned_reviewer_id=$1 and status='pending' for update",
              [c.agent_id],
            )
          ).rows;
          for (const r of rows) await escalateApproval(tx, r, "manager_unavailable");
        });
      }
    }
  }
}
