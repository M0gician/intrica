import type { Sql, Tx } from "../../../adapters/postgres/database.js";
import type { ExecutionContext } from "../../execution/worker.js";
import type { ConversationInput } from "../conversations.js";
import { completionState, requestCompletionReview } from "../messaging/completion.js";
export async function finishConversation(
  ctx: ExecutionContext,
  input: ConversationInput,
  pending: (sql: Sql) => Promise<boolean>,
  hasUnread: (sql: Sql) => Promise<boolean>,
  humanReason: (sql: Sql) => Promise<string | null>,
  exhausted: () => boolean,
  persist: (tx: Tx) => Promise<void>,
) {
  if ((await pending(ctx.store.db.pool)) || (await hasUnread(ctx.store.db.pool))) return false;
  const human = (await humanReason(ctx.store.db.pool)) ?? (exhausted() ? "turn_limit" : null);
  const completion = human
    ? undefined
    : await completionState(ctx.store.db.pool, input.conversationId, ctx.run.id);
  const reason =
    human ??
    (completion?.kind === "waiting"
      ? "message"
      : completion?.kind === "blocked"
        ? "inbox_review"
        : null);
  return ctx.store.finish(
    ctx.run,
    reason ? "waiting" : "succeeded",
    async (tx) => {
      if (
        (await hasUnread(tx)) ||
        (await pending(tx)) ||
        ((await humanReason(tx)) ?? (exhausted() ? "turn_limit" : null)) !== human
      )
        return false;
      await persist(tx);
      if (!human) {
        const current = await completionState(tx, input.conversationId, ctx.run.id);
        if (current.fingerprint !== completion?.fingerprint || current.kind !== completion?.kind)
          return false;
        if (current.kind === "review") {
          await requestCompletionReview(tx, ctx.run, current);
          return false;
        }
      }
    },
    reason,
  );
}
