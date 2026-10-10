import {
  canvasEvent,
  type Database,
  DomainError,
  id,
  type Tx,
} from "../../adapters/postgres/database.js";
import { appendMessage } from "../execution/messages.js";
import { retainDependency } from "../execution/request-lifecycle.js";
import type { RunStore } from "../execution/store.js";
import { waitSnapshot } from "./wait-notices.js";

export const maxWaitSeconds = () =>
  Math.max(1, Math.min(604800, Number(process.env.INTRICA_MESSAGE_WAIT_MAX_SECONDS) || 86400));

/** All transitions run under the canvas lock; the row and notice key arbitrate races. */
export class MessageWaits {
  private cursor = "";
  constructor(
    readonly db: Database,
    readonly runs: RunStore,
  ) {}

  async register(
    tx: Tx,
    input: {
      canvasId: string;
      conversationId: string;
      workItemId?: string | undefined;
      runId: string;
      callId: string;
      generation?: number | undefined;
      requestIds?: string[];
      timeoutSeconds?: number;
    },
  ) {
    if (input.timeoutSeconds !== undefined && input.timeoutSeconds > maxWaitSeconds())
      throw new DomainError("VALIDATION", `timeoutSeconds exceeds ${maxWaitSeconds()}`);
    const c = (await tx.query("select * from conversations where id=$1", [input.conversationId]))
      .rows[0];
    if (!c || c.identity_kind === "deleted_agent") throw new DomainError("NOT_FOUND", "会话不存在");
    if (input.generation !== undefined && input.generation !== Number(c.generation))
      throw new DomainError("STALE_OUTPUT", "等待注册已被新的输入取代");
    if (input.workItemId) {
      const own = (
        await tx.query(
          `select 1 from message_requests where id=$1 and recipient_conversation_id=$2
        and state='open' and work_state not in('stopped','closed')`,
          [input.workItemId, input.conversationId],
        )
      ).rowCount;
      if (!own) throw new DomainError("INVALID_STATE", "当前任务已结束或停止");
    }
    const requests = input.requestIds ?? [];
    if (requests.length) {
      const owned = (
        await tx.query(
          `select id from message_requests r where id=any($1::text[])
        and canvas_id=$2 and sender_kind<>'user' and (sender_conversation_id=$3 or exists(
          select 1 from request_dependencies d join message_requests p on p.id=d.parent_id where d.child_id=r.id
          and d.released_at is null and p.recipient_conversation_id=$3 and p.state='open' and p.work_state<>'stopped'))`,
          [requests, input.canvasId, input.conversationId],
        )
      ).rows;
      if (owned.length !== requests.length)
        throw new DomainError("FORBIDDEN", "只能等待当前会话发出的请求");
      if (input.workItemId)
        for (const requestId of requests) await retainDependency(tx, input.workItemId, requestId);
    }
    await tx.query(
      `update message_waits set state='cancelled',release_reason='replaced',released_at=now()
      where conversation_id=$1 and work_item_id is not distinct from $2 and state='active'`,
      [input.conversationId, input.workItemId ?? null],
    );
    const wait = (
      await tx.query(
        `insert into message_waits(id,canvas_id,conversation_id,work_item_id,run_id,tool_call_id,
      generation,mode,request_ids,baseline_seq,deadline) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
      case when $11::int is null then null else now()+$11*interval '1 second' end) returning *`,
        [
          id("wait"),
          input.canvasId,
          input.conversationId,
          input.workItemId ?? null,
          input.runId,
          input.callId,
          c.generation,
          requests.length ? "requests" : input.workItemId ? "external" : "idle",
          requests,
          c.consumed_message_seq,
          input.timeoutSeconds ?? null,
        ],
      )
    ).rows[0];
    if (input.workItemId)
      await tx.query(
        `update message_requests set work_state='waiting',blocked_reason='message'
      where id=$1`,
        [input.workItemId],
      );
    await this.check(tx, wait);
    const current = (await tx.query("select * from message_waits where id=$1", [wait.id])).rows[0];
    await canvasEvent(tx, input.canvasId, "conversation.changed", {
      conversationId: input.conversationId,
    });
    return { waitingForMessage: current.state === "active", ...(await waitSnapshot(tx, current)) };
  }

  async incoming(tx: Tx, conversationId: string) {
    const rows = (
      await tx.query("select * from message_waits where conversation_id=$1 and state='active'", [
        conversationId,
      ])
    ).rows;
    for (const wait of rows) await this.check(tx, wait);
  }

  private async check(tx: Tx, wait: any, force?: "wake" | "cancel") {
    const c = (await tx.query("select * from conversations where id=$1", [wait.conversation_id]))
      .rows[0];
    const work = wait.work_item_id
      ? (await tx.query("select * from message_requests where id=$1", [wait.work_item_id])).rows[0]
      : null;
    const source = (await tx.query("select * from runs where id=$1", [wait.run_id])).rows[0];
    if (
      !c ||
      c.identity_kind === "deleted_agent" ||
      source?.cancel_requested_at ||
      source?.state === "cancelled" ||
      (wait.work_item_id &&
        (work?.state !== "open" ||
          work.work_state === "stopped" ||
          work.recipient_conversation_id !== c.id))
    ) {
      await tx.query(
        `update message_waits set state='cancelled',release_reason='owner_closed',released_at=now() where id=$1 and state='active'`,
        [wait.id],
      );
      return;
    }
    const match = (
      await tx.query(
        `select 1 from messages m where m.conversation_id=$1 and m.consumed_run_id is null
      and m.content->>'closed' is distinct from 'true' and m.content->>'passive' is distinct from 'true'
      and m.content->>'activationBlocked' is distinct from 'true'
      and (m.role<>'message' or m.content ? 'from')
      and (m.seq>$2 or m.content->>'workItemId' is not null)
      and (m.role='user' and m.content->>'workItemId' is not distinct from $3
        or m.role in('user','message','trigger') and
        case when $4='requests' then m.content->>'inReplyTo'=any($5::text[])
        else m.content->>'workItemId' is null or m.content->>'workItemId'=$3 end) limit 1`,
        [c.id, wait.baseline_seq, wait.work_item_id, wait.mode, wait.request_ids],
      )
    ).rowCount;
    const settled =
      wait.request_ids.length &&
      (
        await tx.query(
          "select 1 from message_requests where id=any($1::text[]) and state<>'open' limit 1",
          [wait.request_ids],
        )
      ).rowCount;
    const due = wait.deadline && new Date(wait.deadline).getTime() <= Date.now();
    const reason =
      force ?? (match ? "message" : settled ? "request_closed" : due ? "timeout" : null);
    if (!reason) return;
    const barrier = await this.runs.conversationBarrier(c.id, tx);
    const active = (
      await tx.query(
        "select * from runs where subject_id=$1 and state in('running','queued','waiting') order by created_at desc limit 1",
        [c.id],
      )
    ).rows[0];
    if (
      barrier.unknown ||
      barrier.paused ||
      active?.cancel_requested_at ||
      (active?.state === "waiting" &&
        !["message", "reply_required", "message_protocol", "tool_input", "approval"].includes(
          active.reason,
        ))
    ) {
      if (force === "cancel") {
        await tx.query(
          "update message_waits set state='cancelled',release_reason='cancel',released_at=now() where id=$1 and state='active'",
          [wait.id],
        );
        return;
      }
      await tx.query("update message_waits set blocked_reason=$2 where id=$1", [
        wait.id,
        barrier.unknown
          ? "unknown"
          : barrier.paused
            ? "tool_contract_upgrade"
            : (active?.reason ?? "stopping"),
      ]);
      if (force) throw new DomainError("INVALID_STATE", "请先处理已停止的运行或未知工具结果");
      return;
    }
    if (active?.state === "waiting") {
      try {
        await this.runs.enqueue(tx, {
          canvasId: wait.canvas_id,
          subjectId: c.id,
          kind: "conversation",
          frozen: active.frozen_input,
          ...(force ? { userInitiated: true } : { causeId: work?.cause_id ?? source.cause_id }),
        });
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "LIMIT_REACHED") throw error;
        await tx.query("update message_waits set blocked_reason='activation_limit' where id=$1", [
          wait.id,
        ]);
        return;
      }
    }
    const changed = await tx.query(
      `update message_waits set state=$3,release_reason=$2,blocked_reason=null,released_at=now()
      where id=$1 and state='active' returning id`,
      [wait.id, reason, reason === "cancel" ? "cancelled" : "released"],
    );
    if (!changed.rowCount) return;
    if (wait.work_item_id)
      await tx.query(
        "update message_requests set work_state='queued',blocked_reason=null where id=$1 and state='open'",
        [wait.work_item_id],
      );
    const seq = await appendMessage(
      tx,
      c.id,
      `wait-${wait.id}-released`,
      "wait_notice",
      {
        ...(await waitSnapshot(tx, wait)),
        reason,
        causeId: work?.cause_id ?? source.cause_id,
      },
      active?.id,
    );
    await tx.query("update message_waits set notice_seq=$2 where id=$1", [wait.id, seq]);
    await canvasEvent(tx, wait.canvas_id, "conversation.changed", {
      conversationId: c.id,
      waitId: wait.id,
    });
  }

  async control(conversationId: string, waitId: string, action: "wake" | "cancel") {
    const row = (
      await this.db.pool.query(
        "select canvas_id from message_waits where id=$1 and conversation_id=$2",
        [waitId, conversationId],
      )
    ).rows[0];
    if (!row) throw new DomainError("NOT_FOUND", "等待记录不存在");
    return this.db.canvas(row.canvas_id, async (tx) => {
      const wait = (await tx.query("select * from message_waits where id=$1", [waitId])).rows[0];
      if (wait.state === "active") await this.check(tx, wait, action);
      await canvasEvent(tx, row.canvas_id, "conversation.changed", { conversationId });
      return (
        await tx.query("select state,release_reason from message_waits where id=$1", [waitId])
      ).rows[0];
    });
  }

  async maintain() {
    const rows = (
      await this.db.pool.query(
        `select w.id,w.canvas_id from message_waits w join canvases c on c.id=w.canvas_id
      where w.state='active' and c.deleted_at is null order by (w.id<=$1),w.id limit 128`,
        [this.cursor],
      )
    ).rows;
    this.cursor = rows.at(-1)?.id ?? "";
    for (const row of rows)
      await this.db.canvas(row.canvas_id, async (tx) => {
        const wait = (
          await tx.query("select * from message_waits where id=$1 and state='active'", [row.id])
        ).rows[0];
        if (wait) await this.check(tx, wait);
      });
  }
}
