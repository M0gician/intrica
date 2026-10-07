import { digest } from "../../adapters/postgres/database.js";
import type { ToolResult } from "./tool-calls.js";

export type CheckpointCall = { index: number; id: string; name: string; arguments: unknown };
export type CallIdentity = {
  id: string;
  run_id: string;
  logical_call_id: string;
  name: string;
  args_hash: string;
};

export function openCheckpointCalls(checkpoint: any[]): CheckpointCall[] {
  return checkpoint.flatMap((message, index) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
    const following = checkpoint.slice(index + 1);
    const nextAssistant = following.findIndex((m) => m.role === "assistant");
    const responses = following.slice(0, nextAssistant < 0 ? undefined : nextAssistant);
    return message.content
      .filter(
        (part: any) =>
          part.type === "toolCall" &&
          !responses.some((m) => m.role === "toolResult" && m.toolCallId === part.id),
      )
      .map((part: any) => ({ index, id: part.id, name: part.name, arguments: part.arguments }));
  });
}

/** Provider IDs alone are insufficient when a conversation contains repeated turns. */
export function matchCheckpointCall<T extends CallIdentity>(
  entry: CheckpointCall,
  calls: T[],
  pendingTurnId?: string,
  lastAssistant?: number,
): T | undefined {
  const matches = calls.filter(
    (call) =>
      call.name === entry.name &&
      call.args_hash === digest(entry.arguments) &&
      (call.logical_call_id === entry.id || call.logical_call_id.endsWith(`:${entry.id}`)),
  );
  if (entry.index === lastAssistant && pendingTurnId) {
    const exact = matches.filter((call) => call.logical_call_id === `${pendingTurnId}:${entry.id}`);
    if (exact.length === 1) return exact[0];
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export function closeCheckpointCall(
  checkpoint: any[],
  entry: CheckpointCall,
  output: ToolResult,
  callId: string,
  failed: boolean,
) {
  checkpoint.splice(entry.index + 1, 0, {
    role: "toolResult",
    toolCallId: entry.id,
    toolName: entry.name,
    content: output.content,
    isError: failed,
    timestamp: Date.now(),
    intricaCallId: callId,
  });
}
