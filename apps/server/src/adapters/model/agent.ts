import type { AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { streamSimple as compatStreamSimple } from "@earendil-works/pi-ai/compat";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { modelThinkingLevel } from "./model-catalog.js";
import { resolveModel } from "./pi.js";
import { retryTimedOutRequests } from "./request-retry.js";
import type { ModelConfig } from "./types.js";
import { meteredStream } from "./usage.js";

/** One provider turn only. Durable orchestration and tool execution belong to execution. */
export class Agent {
  readonly state: {
    model: Model<Api>;
    tools: AgentTool[];
    messages: AgentMessage[];
    thinkingLevel: string;
    systemPrompt: string;
  };
  private abortController = new AbortController();
  constructor(
    model: Model<Api>,
    thinkingLevel: string,
    private stream: StreamFn,
    private apiKey?: string,
  ) {
    this.state = {
      model,
      thinkingLevel,
      tools: [],
      messages: [],
      systemPrompt:
        "You are the Intrica workspace assistant. Follow the user’s requested language, otherwise respond in the language of their message.",
    };
  }
  abort() {
    this.abortController.abort();
  }
  async prompt(message: string) {
    this.state.messages.push({ role: "user", content: message, timestamp: Date.now() });
    return this.turn();
  }
  async turn(
    signal?: AbortSignal,
    progress?: (message: AssistantMessage) => Promise<void>,
  ): Promise<AssistantMessage> {
    const combined = signal
      ? AbortSignal.any([signal, this.abortController.signal])
      : this.abortController.signal;
    combined.throwIfAborted();
    const options: any = { signal: combined, apiKey: this.apiKey ?? "intrica-keyless" };
    if (this.state.thinkingLevel !== "off") options.reasoning = this.state.thinkingLevel;
    const source = await this.stream(
      this.state.model,
      {
        systemPrompt: this.state.systemPrompt,
        messages: this.state.messages as Message[],
        tools: this.state.tools,
      },
      options,
    );
    const iterator = source[Symbol.asyncIterator]();
    let rejectAbort: (error: unknown) => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(combined.reason ?? new Error("运行已停止"));
    combined.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        const next = await Promise.race([iterator.next(), cancelled]);
        if (next.done) throw new Error("模型未返回完整结果");
        const event = next.value;
        if (event.type === "error") throw new Error(event.error.errorMessage ?? "模型请求失败");
        if (event.type === "done") {
          this.state.messages.push(event.message);
          return event.message;
        }
        if ("partial" in event && progress) await progress(event.partial);
      }
    } finally {
      combined.removeEventListener("abort", onAbort);
    }
  }
}

/** A PI workspace Agent session. Context is replaced each turn; transcript remains in Agent. */
export function createCanvasAgent(
  config: ModelConfig,
  _sessionId: string,
  streamOverride?: StreamFn,
): Agent {
  const options =
    config.kind === "pi"
      ? config
      : { provider: "intrica-mock", modelId: "mock", baseUrl: "http://mock.invalid" };
  const models = builtinModels();
  const resolved = resolveModel(
    options,
    models.getModel(options.provider, options.modelId) ?? null,
    config.kind === "pi"
      ? (config.supportsVision ??
          models.getModel(options.provider, options.modelId)?.input.includes("image") ??
          false)
      : false,
  );
  if (!resolved) throw new Error(`找不到模型 ${options.provider}/${options.modelId}`);
  const mockStream: StreamFn = (model, context, requestOptions) => {
    const stream = createAssistantMessageEventStream();
    const turns = context.messages.filter((message) => message.role === "user").length;
    const response: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: `模拟会话第 ${turns} 轮。\n${context.systemPrompt ?? ""}` }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const latestContent = context.messages.at(-1)?.content;
    const latestText =
      typeof latestContent === "string"
        ? latestContent
        : (latestContent?.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n") ?? "");
    if (
      context.tools?.some((tool) => tool.name === "read_canvas") &&
      context.messages.at(-1)?.role === "user" &&
      !/^(?:后台工具 |Background tool )/.test(latestText)
    ) {
      stream.push({
        type: "done",
        reason: "toolUse",
        message: {
          ...response,
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: `read-${turns}`, name: "read_canvas", arguments: {} }],
        },
      });
      return stream;
    }
    void (async () => {
      const text = response.content[0]!.type === "text" ? response.content[0]!.text : "";
      const partial = { ...response, content: [{ type: "text" as const, text: "" }] };
      stream.push({ type: "start", partial });
      stream.push({ type: "text_start", contentIndex: 0, partial });
      for (let offset = 0; offset < text.length; offset += 80) {
        if (requestOptions?.signal?.aborted) {
          stream.push({
            type: "error",
            reason: "aborted",
            error: { ...response, stopReason: "aborted" },
          });
          return;
        }
        const delta = text.slice(offset, offset + 80);
        partial.content[0]!.text += delta;
        stream.push({ type: "text_delta", contentIndex: 0, delta, partial });
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
      stream.push({ type: "done", reason: "stop", message: response });
    })();
    return stream;
  };
  return new Agent(
    resolved.model,
    modelThinkingLevel(config.kind === "pi" ? config : {}, resolved.model),
    retryTimedOutRequests(
      meteredStream(
        streamOverride ??
          (config.kind === "mock"
            ? mockStream
            : resolved.useCompat
              ? compatStreamSimple
              : models.streamSimple.bind(models)),
      ),
    ),
    config.kind === "pi" ? config.apiKey : undefined,
  );
}
