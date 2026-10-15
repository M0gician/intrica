import type { PiRunner } from "../pi.js";
import type { FrozenOperation, ModelEvent } from "../types.js";

export function sseChunk(content: string, finish = false): string {
  const chunk = {
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: 1,
    model: "stub",
    choices: [
      {
        index: 0,
        delta: content === "" && finish ? {} : { content },
        finish_reason: finish ? "stop" : null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export async function collect(runner: PiRunner, operation: FrozenOperation): Promise<ModelEvent[]> {
  const collected: ModelEvent[] = [];
  for await (const event of runner.run(operation, new AbortController().signal))
    collected.push(event);
  return collected;
}
