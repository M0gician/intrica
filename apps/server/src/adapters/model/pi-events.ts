import type { Api, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import type {
  ContinuationCapabilities,
  InferenceEvent,
  OutputBlock,
} from "../../modules/inference/types.js";

/** Protocol capabilities are selected by adapter API, never by a provider's display name. */
export function continuationCapabilities(api: Api): ContinuationCapabilities {
  const responses = [
    "openai-responses",
    "azure-openai-responses",
    "openai-codex-responses",
  ].includes(api);
  return {
    protocol: api,
    earlyCommit: responses ? "groups" : "terminal",
    required: responses
      ? ["reasoning.id", "reasoning.encrypted_content", "following_output_item"]
      : api === "anthropic-messages"
        ? ["thinking.signature", "complete_assistant_group"]
        : ["complete_response"],
    interrupt: "bounded_drain",
    recovery: "committed_history",
    nativeSteering: false,
  };
}

function resumable(block: OutputBlock, api: Api) {
  if (["openai-responses", "azure-openai-responses", "openai-codex-responses"].includes(api)) {
    const item = block.nativeItem;
    if (
      !item ||
      typeof item.id !== "string" ||
      !item.id ||
      ["in_progress", "incomplete"].includes(String(item.status))
    )
      return false;
    if (block.type === "text")
      return item.type === "message" && item.role === "assistant" && Array.isArray(item.content);
    if (block.type === "toolCall")
      return (
        ["function_call", "custom_tool_call"].includes(String(item.type)) &&
        typeof item.call_id === "string" &&
        block.id === `${item.call_id}|${item.id}` &&
        block.name === item.name &&
        typeof (item.type === "function_call" ? item.arguments : item.input) === "string"
      );
    try {
      const signature = JSON.parse(block.thinkingSignature ?? "null");
      return (
        item.type === "reasoning" &&
        typeof item.encrypted_content === "string" &&
        item.encrypted_content.length > 0 &&
        signature?.id === item.id &&
        signature?.encrypted_content === item.encrypted_content
      );
    } catch {
      return false;
    }
  }
  if (block.type !== "thinking") return true;
  if (api === "anthropic-messages") return Boolean(block.thinkingSignature?.trim());
  // Other adapters own response-level replay; their reasoning stays in its native representation.
  return true;
}

/** Snapshot mutable PI blocks; content close and continuation readiness are independent events. */
export class PiEvents {
  readonly capabilities: ContinuationCapabilities;
  private closed = new Set<number>();
  private emitted = new Set<number>();
  private started = new Set<number>();
  constructor(readonly model: Model<Api>) {
    this.capabilities = continuationCapabilities(model.api);
  }
  events(event: AssistantMessageEvent): InferenceEvent[] {
    const output: InferenceEvent[] = [];
    if (event.type === "start") return [{ type: "request.started" }];
    if (event.type === "error") return [{ type: "request.ended", reason: event.reason }];
    const terminal = event.type === "done";
    const message = structuredClone(terminal ? event.message : event.partial);
    if (!terminal && "contentIndex" in event) {
      const index = event.contentIndex,
        block = message.content[index];
      if (!block) return output;
      if (!this.started.has(index)) {
        this.started.add(index);
        output.push({ type: "item.started", index, block });
      }
      const close = event.type.endsWith("_end");
      if (close) this.closed.add(index);
      output.push({ type: close ? "item.closed" : "item.delta", index, block });
    }
    if (terminal) {
      for (const [index, block] of message.content.entries()) {
        if (this.emitted.has(index)) continue;
        this.closed.add(index);
        output.push({ type: "item.closed", index, block });
      }
    }
    if (terminal || this.capabilities.earlyCommit !== "terminal") {
      const ready: number[] = [];
      for (const [index, block] of message.content.entries()) {
        if (this.emitted.has(index)) continue;
        if (!this.closed.has(index) || !resumable(block, this.model.api)) break;
        ready.push(index);
        // Responses reasoning is committed with its following complete output item.
        if (
          block.type === "thinking" &&
          (this.capabilities.earlyCommit === "groups" || this.model.api === "anthropic-messages")
        )
          continue;
        if (this.capabilities.earlyCommit === "groups" || index === message.content.length - 1) {
          output.push({
            type: "item.continuation_ready",
            indexes: [...ready],
            message: {
              ...message,
              content: ready.map((i) => message.content[i]!),
              stopReason: ready.some((i) => message.content[i]!.type === "toolCall")
                ? "toolUse"
                : "stop",
            },
          });
          for (const i of ready) this.emitted.add(i);
          ready.length = 0;
        }
      }
    }
    if (terminal) output.push({ type: "request.ended", reason: event.reason, message });
    return output;
  }
}
