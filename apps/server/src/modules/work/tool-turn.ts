import type { ToolCall } from "@earendil-works/pi-ai";
import type { Agent } from "../../adapters/model/agent.js";
import type { BackgroundTools } from "../execution/background-tools.js";
import type { ExecutionTool, ToolExecution } from "../execution/tool-calls.js";
import type { ExecutionContext } from "../execution/worker.js";

/** Read operations share a batch. Each result retains its model call ID. */
export async function executeToolBatch(
  ctx: ExecutionContext,
  model: Agent,
  tools: ExecutionTool[],
  background: BackgroundTools,
  outstanding: ToolCall[],
  index: number,
  pendingTurnId: string,
  toolSchemaVersion: number,
) {
  const limits = await ctx.store.settings.limits();
  const batch = [outstanding[index++]!];
  const parallel = (name: string) =>
    tools.some((t) => t.name === name && t.effect === "read" && t.parallel);
  if (parallel(batch[0]!.name))
    while (
      index < outstanding.length &&
      batch.length < limits.toolsPerAgent &&
      parallel(outstanding[index]!.name)
    )
      batch.push(outstanding[index++]!);
  // Await all receipts before checkpointing: no sibling result is lost if one read fails.
  const settled = await Promise.allSettled(
    batch.map(async (call): Promise<ToolExecution> => {
      const tool = tools.find((t) => t.name === call.name);
      return background.invoke(tool ?? call.name, `${pendingTurnId}:${call.id}`, call.arguments, {
        inputVersion: toolSchemaVersion,
      });
    }),
  );
  const rejected = settled.find((r) => r.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
  let waiting: ToolExecution["waiting"];
  for (let i = 0; i < batch.length; i++) {
    const call = batch[i]!;
    const item = settled[i]!;
    if (item.status !== "fulfilled") continue;
    const outcome = item.value;
    if (outcome.waiting === "approval")
      await background.parkApproval(`${pendingTurnId}:${call.id}`);
    if (!outcome.waiting || outcome.waiting === "message" || outcome.waiting === "approval")
      model.state.messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: outcome.result.content,
        isError: Boolean(outcome.result.isError),
        timestamp: Date.now(),
      });
    if (
      outcome.waiting &&
      outcome.waiting !== "approval" &&
      (!waiting || outcome.waiting === "unknown" || waiting === "message")
    )
      waiting = outcome.waiting;
  }
  return { index, waiting };
}
