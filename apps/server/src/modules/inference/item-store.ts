import type { Agent } from "../../adapters/model/agent.js";
import { assertFence, canvasEvent, digest, type Tx } from "../../adapters/postgres/database.js";
import { appendMessage } from "../execution/messages.js";
import type { ExecutionContext } from "../execution/worker.js";
import { inferenceState, writableAttempt } from "./lifecycle.js";
import type {
  ContextMessage,
  InferenceEvent,
  InferenceIdentity,
  ItemState,
  OutputBlock,
} from "./types.js";

function visible(block: OutputBlock) {
  return block.type === "thinking"
    ? { thinking: block.thinking }
    : block.type === "text"
      ? { text: block.text }
      : { toolName: block.name, providerCallId: block.id };
}

/** Native continuation is private storage. UI records contain only visible content and state. */
export class ItemStore {
  constructor(
    readonly ctx: ExecutionContext,
    readonly identity: InferenceIdentity,
  ) {}
  itemId(index: number) {
    return `${this.identity.attemptId}:${index}`;
  }
  private async project(tx: Tx, row: any) {
    const data = {
      id: row.id,
      requestId: this.identity.requestId,
      attemptId: this.identity.attemptId,
      itemKind: row.kind,
      state: row.state,
      version: row.version,
      publication: row.publication,
      workItemId: this.identity.workItemId,
      contextSeq: row.context_seq,
      ...visible(row.payload),
    };
    const key = `inference-item-${row.id}`;
    await appendMessage(
      tx,
      this.identity.conversationId,
      key,
      "inference_item",
      data,
      this.identity.runId,
    );
    await tx.query(
      "update messages set content=$3 where conversation_id=$1 and client_message_id=$2",
      [this.identity.conversationId, key, JSON.stringify(data)],
    );
    await this.ctx.store.eventTx(
      tx,
      this.identity.runId,
      this.ctx.run.attemptId,
      "inference.item",
      data,
    );
    await canvasEvent(tx, this.ctx.run.canvas_id, "conversation.changed", {
      conversationId: this.identity.conversationId,
    });
  }
  async observe(index: number, block: OutputBlock, state: "streaming" | "closed") {
    await this.ctx.store.db.canvas(this.ctx.run.canvas_id, async (tx) => {
      if (!(await writableAttempt(tx, this.identity))) return;
      const row = (
        await tx.query(
          `insert into inference_items(id,attempt_id,ordinal,kind,state,payload) values($1,$2,$3,$4,$5,$6)
        on conflict(id) do update set state=excluded.state,payload=excluded.payload,version=inference_items.version+1,updated_at=now()
        where inference_items.state in('streaming','closed') and
        (inference_items.payload is distinct from excluded.payload or inference_items.state<>excluded.state)
        returning *`,
          [
            this.itemId(index),
            this.identity.attemptId,
            index,
            block.type,
            state,
            JSON.stringify(block),
          ],
        )
      ).rows[0];
      if (row) await this.project(tx, row);
    });
  }
  async commit(
    event: Extract<InferenceEvent, { type: "item.continuation_ready" }>,
    model: Agent,
    persist: (tx: Tx) => Promise<void>,
  ) {
    return this.ctx.store.db.canvas(this.ctx.run.canvas_id, async (tx) => {
      if (!(await writableAttempt(tx, this.identity))) return null;
      const rows = (
        await tx.query(
          "select * from inference_items where id=any($1::text[]) and state='closed' order by ordinal for update",
          [event.indexes.map((index) => this.itemId(index))],
        )
      ).rows;
      if (rows.length !== event.indexes.length) return null;
      // An adapter-ready group is indivisible. It becomes history before any tool can dispatch.
      const message: ContextMessage = {
        ...event.message,
        intrica: {
          requestId: this.identity.requestId,
          workItemId: this.identity.workItemId,
          decisionRevision: this.identity.decisionRevision,
          itemVersions: rows.map((row) => ({ id: row.id, version: row.version + 1 })),
        },
      };
      model.state.messages.push(message);
      try {
        await persist(tx);
        const seq = message.intrica?.contextSeq;
        const committed = (
          await tx.query(
            `update inference_items set state='committed',version=version+1,context_seq=$2,protocol_group=$3,updated_at=now()
          where id=any($1::text[]) returning *`,
            [rows.map((r) => r.id), seq, digest(rows.map((r) => r.id))],
          )
        ).rows;
        for (const row of committed) await this.project(tx, row);
        return message;
      } catch (error) {
        model.state.messages.splice(model.state.messages.indexOf(message), 1);
        throw error;
      }
    });
  }
  async seal(outcome: string, final = true) {
    await this.ctx.store.db.canvas(this.ctx.run.canvas_id, async (tx) => {
      await assertFence(tx, this.identity.runId, this.identity.leaseEpoch);
      const changed = await tx.query(
        "update inference_attempts set state='sealed',outcome=$2,sealed_at=clock_timestamp() where id=$1 and state<>'sealed' returning id",
        [this.identity.attemptId, outcome],
      );
      if (!changed.rowCount) return;
      const discarded = (
        await tx.query(
          "update inference_items set state='discarded',version=version+1,updated_at=now() where attempt_id=$1 and state in('streaming','closed') returning *",
          [this.identity.attemptId],
        )
      ).rows;
      for (const row of discarded) await this.project(tx, row);
      await tx.query(
        "update inference_requests set state=$2,reason=$3,sealed_at=case when $2='sealed' then clock_timestamp() end where id=$1",
        [this.identity.requestId, final ? "sealed" : "prepared", outcome],
      );
      await inferenceState(this.ctx, tx, this.identity, final ? "sealed" : "prepared", outcome);
    });
  }
  async states(): Promise<ItemState[]> {
    return (
      await this.ctx.store.db.pool.query(
        "select state from inference_items where attempt_id=$1 order by ordinal",
        [this.identity.attemptId],
      )
    ).rows.map((r) => r.state);
  }
}
