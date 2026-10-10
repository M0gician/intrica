import type { Tx } from "../../adapters/postgres/database.js";
import type { BackgroundTools } from "../execution/background-tools.js";
import type { ToolExecution } from "../execution/tool-calls.js";
import type { ExecutionContext } from "../execution/worker.js";
import type { ConversationInput } from "./conversations.js";
import { waitForWork } from "./work-items.js";

/** A tool suspension keeps background receipts alive and rechecks incoming input atomically. */
export async function holdForTools(
  ctx: ExecutionContext,
  background: BackgroundTools,
  input: ConversationInput,
  waiting: NonNullable<ToolExecution["waiting"]>,
  persist: (tx: Tx) => Promise<void>,
  hasUnread: (tx: Pick<Tx, "query">) => Promise<boolean>,
) {
  const inputWait = waiting === "message" || waiting === "tool_input";
  if (inputWait)
    await ctx.store.db.canvas(ctx.run.canvas_id, (tx) =>
      waitForWork(tx, input.conversationId, input.workItemId, waiting),
    );
  if (await background.pendingIn(ctx.store.db.pool)) {
    await background.wait();
    return { stopped: false, waitingForInput: inputWait };
  }
  const stopped = await ctx.store.finish(
    ctx.run,
    "waiting",
    async (tx) => {
      if (inputWait && (await hasUnread(tx))) return false;
      if (waiting === "approval" || waiting === "unknown") {
        const pending = (
          await tx.query("select 1 from tool_calls where run_id=$1 and state=$2 limit 1", [
            ctx.run.id,
            waiting === "approval" ? "waiting" : "unknown",
          ])
        ).rowCount;
        if (!pending) return false;
      }
      await persist(tx);
    },
    waiting,
  );
  return { stopped, waitingForInput: false };
}
