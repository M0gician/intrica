import type { AssistantMessage } from "@earendil-works/pi-ai";

export function emptyAssistantMessage(
  model: Pick<AssistantMessage, "api" | "provider"> & { id: string },
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    model: model.id,
    provider: model.provider,
    api: model.api,
    timestamp: Date.now(),
    stopReason: "error",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
