import type { ToolCall } from "@earendil-works/pi-ai";
import type { Agent } from "../../adapters/model/agent.js";
import { DomainError } from "../../adapters/postgres/database.js";
import type { BackgroundTools } from "../execution/background-tools.js";
import type { ExecutionTool } from "../execution/tool-calls.js";
import type { ExecutionContext } from "../execution/worker.js";
import { provenance } from "../inference/context-projection.js";
import { executeToolBatch } from "./tool-turn.js";

/** Drains every committed group in order, preserving each group's original task and decision. */
export async function admitTools(
  ctx: ExecutionContext,
  model: Agent,
  tools: ExecutionTool[],
  background: BackgroundTools,
  fallbackRequestId: string,
  schemaVersion: number,
  checkpoint: () => Promise<void>,
  interrupt?: AbortSignal,
) {
  const history = [...model.state.messages];
  for (let offset = 0; offset < history.length; offset++) {
    const message = history[offset]!;
    if (message.role !== "assistant") continue;
    const results = new Set(
      history
        .slice(offset + 1)
        .flatMap((entry) => (entry.role === "toolResult" ? [entry.toolCallId] : [])),
    );
    const calls = message.content.filter(
      (p): p is ToolCall => p.type === "toolCall" && !results.has(p.id),
    );
    for (let index = 0; index < calls.length; ) {
      const next = await executeToolBatch(
        ctx,
        model,
        tools,
        background,
        calls,
        index,
        provenance(message).requestId ?? fallbackRequestId,
        schemaVersion,
        interrupt,
      );
      index = next.index;
      await checkpoint();
      if (next.waiting)
        throw new DomainError("INFERENCE_TOOL_WAIT", next.waiting, { waiting: next.waiting });
    }
  }
}
