import type { ToolCall } from "@earendil-works/pi-ai";
import type { Agent } from "../../adapters/model/agent.js";
import { assertFence, canvasEvent } from "../../adapters/postgres/database.js";
import type { BackgroundTools } from "../execution/background-tools.js";
import type { ExecutionTool, ToolExecution } from "../execution/tool-calls.js";
import type { ExecutionContext } from "../execution/worker.js";
import { provenance } from "../inference/context-projection.js";
import type { ContextMessage } from "../inference/types.js";

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
  interrupt?: AbortSignal,
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
      const observed = call as ToolCall & {
        observationId?: string;
        argumentError?: string;
        modelContentIndex?: number;
      };
      const owner = [...model.state.messages]
        .reverse()
        .find((m) => m.role === "assistant" && m.content.includes(call));
      const source = owner ? provenance(owner) : {};
      const index = owner?.role === "assistant" ? owner.content.indexOf(call) : -1;
      return background.invoke(
        tool ?? call.name,
        `${source.requestId ?? pendingTurnId}:${call.id}`,
        call.arguments,
        {
          interrupt,
          inputVersion: toolSchemaVersion,
          observation: {
            generationId: source.requestId ?? pendingTurnId,
            ...(source.decisionRevision !== undefined
              ? { decisionRevision: source.decisionRevision }
              : {}),
            ...(source.requestId ? { workItemId: source.workItemId ?? null } : {}),
            ...(source.itemVersions?.[index]
              ? { inferenceItemId: source.itemVersions[index]!.id }
              : {}),
            providerCallId: call.id,
            ...(observed.observationId ? { observationId: observed.observationId } : {}),
            ...(observed.argumentError ? { parseError: observed.argumentError } : {}),
            ...(observed.modelContentIndex !== undefined
              ? { contentIndex: observed.modelContentIndex }
              : {}),
          },
        },
      );
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
    const owner = [...model.state.messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.content.includes(call));
    const source = owner ? provenance(owner) : {};
    if (outcome.waiting === "approval")
      await background.parkApproval(`${source.requestId ?? pendingTurnId}:${call.id}`);
    if (
      !outcome.waiting ||
      outcome.waiting === "message" ||
      outcome.waiting === "approval" ||
      outcome.waiting === "tool_input"
    ) {
      const response = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: outcome.result.content,
        isError: Boolean(outcome.result.isError),
        timestamp: Date.now(),
      } as ContextMessage;
      // Save the one primary response before checkpointing it. Final async results are updates.
      const saved = await ctx.store.db.canvas(ctx.run.canvas_id, async (tx) => {
        await assertFence(tx, ctx.run.id, ctx.run.epoch);
        const { rows } = await tx.query(
          "update tool_calls set primary_response=$3 where run_id=$1 and logical_call_id=$2 and primary_response is null returning id,primary_response",
          [ctx.run.id, `${source.requestId ?? pendingTurnId}:${call.id}`, JSON.stringify(response)],
        );
        if (rows[0]) {
          await ctx.store.eventTx(tx, ctx.run.id, ctx.run.attemptId, "tool.response", {
            callId: rows[0].id,
            toolCallId: call.id,
          });
          await canvasEvent(tx, ctx.run.canvas_id, "conversation.changed", {
            conversationId: ctx.run.subject_id,
          });
          return rows[0].primary_response;
        }
        return (
          (
            await tx.query(
              "select primary_response from tool_calls where run_id=$1 and logical_call_id=$2",
              [ctx.run.id, `${source.requestId ?? pendingTurnId}:${call.id}`],
            )
          ).rows[0]?.primary_response ?? response
        );
      });
      model.state.messages.push(saved);
    }
    if (
      outcome.waiting &&
      outcome.waiting !== "approval" &&
      (!waiting || outcome.waiting === "unknown" || waiting === "message")
    )
      waiting = outcome.waiting;
  }
  return { index, waiting };
}
