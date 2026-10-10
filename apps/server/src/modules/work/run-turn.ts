import type { createCanvasAgent } from "../../adapters/model/agent.js";
import { withModelTurn } from "../../adapters/model/usage.js";
import { DomainError } from "../../adapters/postgres/database.js";
import type { BackgroundTools } from "../execution/background-tools.js";
import { MessageStream } from "../execution/message-stream.js";
import type { ExecutionContext } from "../execution/worker.js";

/** Draft events are diagnostics, never published messages. */
export async function runTurn(
  model: ReturnType<typeof createCanvasAgent>,
  ctx: ExecutionContext,
  background: BackgroundTools,
  expedited: () => Promise<boolean>,
  round: number,
  generationId: string,
  workItemId: string | undefined,
) {
  let lastEmission = 0;

  const streamingMessage = new MessageStream(`${ctx.run.attemptId}-${round}`, (payload) =>
    ctx.store.event(ctx.run, "message.draft", payload),
  );
  const inferenceAbort = new AbortController();
  const stopMonitor = await background.monitorInference(async () => {
    if (await expedited()) inferenceAbort.abort(new DomainError("EXPEDITED", "有加急输入"));
  });
  let message: import("@earendil-works/pi-ai").AssistantMessage;
  try {
    message = await withModelTurn(generationId, workItemId, () =>
      model.turn(AbortSignal.any([ctx.signal, inferenceAbort.signal]), async (partial) => {
        ctx.progress();
        if (Date.now() - lastEmission < 250) return;
        lastEmission = Date.now();
        await streamingMessage.write(
          partial.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n"),
          partial.content.flatMap((p) => (p.type === "thinking" ? [p.thinking] : [])).join("\n"),
          true,
        );
      }),
    );
  } catch (error) {
    if (inferenceAbort.signal.aborted && !ctx.signal.aborted) {
      await ctx.store.event(ctx.run, "message.draft", {
        id: `${ctx.run.attemptId}-${round}`,
        text: "",
        thinking: "",
        streaming: false,
        interrupted: true,
      });
      return null;
    }
    throw error;
  } finally {
    await stopMonitor();
  }
  await streamingMessage.write(
    message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n"),
    message.content.flatMap((p) => (p.type === "thinking" ? [p.thinking] : [])).join("\n"),
    false,
  );
  return message;
}
