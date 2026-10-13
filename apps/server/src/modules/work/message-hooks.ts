import type { InboxReviewArgs } from "@intrica/contracts";
import { type Database, DomainError, type Sql, type Tx } from "../../adapters/postgres/database.js";
import { updateDelivery } from "./messaging/actions.js";
import type { MessagingContext } from "./messaging/context.js";
import { deliveries, deliveryStatuses } from "./messaging/deliveries.js";
import { tickReminders } from "./messaging/reminders.js";
import { confirmWait, reviewInbox } from "./messaging/review.js";

/** Composition only; delivery, review, reminders and actions have separate modules. */
export class MessageHooks implements MessagingContext {
  constructor(
    readonly db: Database,
    readonly conversations: MessagingContext["conversations"],
  ) {}
  requests(sql: Sql, conversationId: string) {
    return deliveries(sql, conversationId);
  }
  review(tx: Tx, conversationId: string, args: InboxReviewArgs) {
    return reviewInbox(tx, conversationId, args);
  }
  confirmWait(tx: Tx, conversationId: string, confirmed?: boolean, token?: string) {
    return confirmWait(tx, conversationId, confirmed, token);
  }
  update(
    tx: Tx,
    conversationId: string,
    deliveryId: string,
    action: "wait" | "expedite" | "cancel",
    seconds = 120,
    version?: number,
  ) {
    return updateDelivery(this, tx, conversationId, deliveryId, action, seconds, version);
  }
  private async source(deliveryId: string) {
    const row = (
      await this.db.pool.query(
        `select q.sender_conversation_id,q.canvas_id from message_deliveries q
      join canvases c on c.id=q.canvas_id where q.id=$1 and c.deleted_at is null`,
        [deliveryId],
      )
    ).rows[0];
    if (!row) throw new DomainError("NOT_FOUND", "消息投递记录不存在");
    return row;
  }
  async status(deliveryId: string) {
    const row = await this.source(deliveryId);
    return (await deliveries(this.db.pool, row.sender_conversation_id, [deliveryId])).find(
      (q) => q.id === deliveryId,
    );
  }
  async statuses(ids: string[]) {
    if (!ids.length || ids.length > 200)
      throw new DomainError("VALIDATION", "一次查询 1–200 条消息");
    return deliveryStatuses(this.db.pool, ids);
  }
  async updateForOwner(
    deliveryId: string,
    action: "wait" | "expedite" | "cancel",
    seconds: number,
    version: number,
  ) {
    const row = await this.source(deliveryId);
    return this.db.canvas(row.canvas_id, (tx) =>
      this.update(tx, row.sender_conversation_id, deliveryId, action, seconds, version),
    );
  }
  tick() {
    return tickReminders(this);
  }
}
