import type { AddressedMessage } from "@intrica/contracts";
import type { Agent } from "../../adapters/model/agent.js";
import { assertFence, DomainError, type Tx } from "../../adapters/postgres/database.js";
import { promptText } from "../../prompt-language.js";
import { parseAddressedMessage } from "../collaboration/message-contract.js";
import type { ExecutionContext } from "../execution/worker.js";
import type { ConversationInput, Conversations } from "./conversations.js";
import { activateWork, waitForWork } from "./work-items.js";

export type PendingOutput = {
  id: string;
  payload: AddressedMessage;
  generation: number;
  workItemId?: string | undefined;
};
export class OutputCompletion {
  pending: PendingOutput | null;
  repairAttempts: number;
  blocked: boolean;
  constructor(
    private readonly service: Conversations,
    private readonly ctx: ExecutionContext,
    private readonly input: ConversationInput,
    saved: any,
  ) {
    this.pending = saved?.pendingOutput ?? null;
    this.repairAttempts = saved?.messageRepairAttempts ?? 0;
    this.blocked = saved?.messageProtocolBlocked === true;
  }
  get state() {
    return {
      pendingOutput: this.pending,
      messageRepairAttempts: this.repairAttempts,
      messageProtocolBlocked: this.blocked,
    };
  }
  resetRepair() {
    this.repairAttempts = 0;
    this.blocked = false;
  }

  async prepare(tx: Tx, text: string, turnId: string, thinking: string, generation: number) {
    try {
      const payload = parseAddressedMessage(text);
      this.pending = { id: turnId, payload, generation, workItemId: this.input.workItemId };
      return null;
    } catch (error) {
      return this.reject(tx, turnId, error, text, thinking);
    }
  }

  async reject(tx: Tx, turnId: string, error: unknown, text = "", thinking = "") {
    const reason =
      (error instanceof Error ? error.message : "消息未通过校验") +
      (error instanceof DomainError && error.code === "REQUEST_CLOSED" && error.details
        ? ` ${JSON.stringify(error.details)}`
        : "");
    this.pending = null;
    this.repairAttempts++;
    this.blocked = this.repairAttempts > 1;
    if (this.blocked && this.input.workItemId)
      await tx.query(
        "update message_requests set work_state='waiting',blocked_reason='message_protocol' where id=$1 and state='open'",
        [this.input.workItemId],
      );
    await this.service.append(
      tx,
      this.input.conversationId,
      `invalid-output-${turnId}`,
      "output_error",
      {
        text,
        thinking,
        reason,
        code: error instanceof DomainError ? error.code : "MESSAGE_FORMAT",
        state: this.blocked ? "blocked" : "repairing",
        workItemId: this.input.workItemId,
      },
      this.ctx.run.id,
    );
    if (this.input.workItemId)
      await tx.query("update message_requests set blocked_reason=$2 where id=$1 and state='open'", [
        this.input.workItemId,
        reason,
      ]);
    return {
      role: "user" as const,
      timestamp: Date.now(),
      content: promptText(
        this.input.language,
        `Server output validation: ${reason}. This output was not published. Use one JSON object with an explicit target and message. Reply to a request with {"target":{"kind":"request","id":"the supplied request ID"},"kind":"result","message":"your answer"}; a private work note uses {"target":{"kind":"internal"},"message":"your note"}. Already committed tool operations retain their receipts.`,
        `服务端消息校验：${reason}。此输出尚未发布。请输出一个包含明确 target 和 message 的 JSON 对象。回复使用 {"target":{"kind":"request","id":"服务端提供的请求 ID"},"kind":"result","message":"答复"}；内部笔记使用 {"target":{"kind":"internal"},"message":"笔记"}。已经提交的工具操作保留原回执。`,
      ),
    };
  }

  async resume(model: Agent, persist: (tx: Tx) => Promise<void>, checkpoint: () => Promise<void>) {
    const { service, ctx, input } = this;
    await this.restoreReady();
    if (this.pending) {
      const candidate = this.pending;
      const delivery = await this.deliver();
      if (delivery.error)
        await service.db.canvas(ctx.run.canvas_id, async (tx) => {
          await assertFence(tx, ctx.run.id, ctx.run.epoch);
          input.workItemId = candidate.workItemId;
          await activateWork(tx, input.conversationId, input.workItemId);
          const correction = await this.reject(
            tx,
            candidate.id,
            delivery.error,
            JSON.stringify(candidate.payload),
          );
          if (!this.blocked) model.state.messages.push(correction);
          await persist(tx);
        });
      else {
        await checkpoint();
        if (
          !delivery.waiting &&
          ![...model.state.messages]
            .reverse()
            .find((m) => m.role === "assistant")
            ?.content?.some((p: any) => p.type === "toolCall")
        )
          await service.db.canvas(ctx.run.canvas_id, (tx) =>
            waitForWork(tx, input.conversationId, candidate.workItemId, "reply_required"),
          );
      }
      if (delivery.waiting === "unknown") {
        await ctx.store.finish(
          ctx.run,
          "waiting",
          async (tx) => {
            await persist(tx);
          },
          "unknown",
        );
        return true;
      }
      if (delivery.waiting) {
        await service.db.canvas(ctx.run.canvas_id, async (tx) => {
          await assertFence(tx, ctx.run.id, ctx.run.epoch);
          await waitForWork(tx, input.conversationId, candidate.workItemId, "approval");
          await persist(tx);
        });
      }
    }
    return false;
  }

  async restoreReady() {
    if (this.pending) return;
    const row = (
      await this.service.db.pool.query(
        `select d.* from message_dispatches d
      left join approvals a on a.id=d.approval_id where d.conversation_id=$1 and d.origin='final'
      and d.output_handled=false and d.state<>'sent' and (a.id is null or a.status<>'pending')
      order by d.created_at limit 1`,
        [this.input.conversationId],
      )
    ).rows[0];
    if (row)
      this.pending = {
        id: row.logical_id.slice(6),
        payload: row.payload,
        generation: Number(row.generation),
        workItemId: row.work_item_id ?? undefined,
      };
  }
  async handled(pending: PendingOutput) {
    await this.service.db.canvas(this.ctx.run.canvas_id, async (tx) => {
      await assertFence(tx, this.ctx.run.id, this.ctx.run.epoch);
      await tx.query(
        "update message_dispatches set output_handled=true where conversation_id=$1 and logical_id=$2",
        [this.input.conversationId, `final:${pending.id}`],
      );
    });
  }
  async deliver() {
    const pending = this.pending;
    if (!pending) return { waiting: false, error: null };
    try {
      const barrier = await this.ctx.store.conversationBarrier(this.input.conversationId);
      if (barrier.unknown || barrier.paused) return { waiting: "unknown" as const, error: null };
      const receipt = await this.service.messaging.send(
        {
          run: this.ctx.run,
          conversationId: this.input.conversationId,
          agentId: this.input.agentId,
          generation: pending.generation,
          workItemId: pending.workItemId,
          origin: "final",
        },
        pending.payload,
        `final:${pending.id}`,
      );
      if (receipt.status === "pending") {
        this.pending = null;
        return { waiting: "approval" as const, error: null };
      }
      await this.handled(pending);
      this.pending = null;
      this.resetRepair();
      return { waiting: false, error: null };
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      await this.handled(pending);
      if (["STALE_OUTPUT", "STALE_EXECUTION"].includes(error.code)) {
        this.pending = null;
        return { waiting: false, error: null };
      }
      return { waiting: false, error };
    }
  }
}
