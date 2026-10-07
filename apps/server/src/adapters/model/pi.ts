import type {
  Api,
  ImageContent,
  Model,
  Models,
  SimpleStreamOptions,
  TextContent,
  UserMessage,
} from "@earendil-works/pi-ai";
import { streamSimple as compatStreamSimple } from "@earendil-works/pi-ai/compat";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { endpointIdentity } from "@intrica/contracts";
import { modelErrorMessage, modelThinkingLevel } from "./model-catalog.js";
import { buildSystemPrompt, parseModelOutput, serializeContext } from "./prompt.js";
import { retryTimedOutRequests } from "./request-retry.js";
import type { FrozenOperation, ModelConfig, ModelEvent, ModelRunner } from "./types.js";
import { meteredStream } from "./usage.js";

type PiOptions = Omit<Extract<ModelConfig, { kind: "pi" }>, "kind">;

type ResolvedModel = { model: Model<Api>; useCompat: boolean };

export class PiRunner implements ModelRunner {
  readonly supportsVision: boolean;
  private readonly options: PiOptions;
  private readonly resolved: ResolvedModel | null;

  constructor(options: PiOptions) {
    this.options = options;
    const models: Models = builtinModels();
    const found = models.getModel(options.provider, options.modelId) ?? null;
    this.supportsVision = options.supportsVision ?? found?.input.includes("image") ?? false;
    this.resolved = resolveModel(options, found, this.supportsVision);
  }

  private async buildUserContent(op: FrozenOperation): Promise<string | UserMessage["content"]> {
    const blocks: (TextContent | ImageContent)[] = [
      { type: "text", text: serializeContext(op.contextSnapshot) },
    ];
    if (!this.supportsVision || op.resolveAsset === undefined) {
      return blocks;
    }
    const seen = new Set<string>();
    const refs: Array<{ assetId: string; assetVersion: number }> = [];
    const scope = op.contextSnapshot.scope;
    if (scope.kind === "image" && scope.assetId !== undefined && scope.assetVersion !== undefined) {
      refs.push({ assetId: scope.assetId, assetVersion: scope.assetVersion });
    }
    for (const node of op.contextSnapshot.nodes) {
      if (node.kind !== "image" || node.assetId === undefined || node.assetVersion === undefined) {
        continue;
      }
      refs.push({ assetId: node.assetId, assetVersion: node.assetVersion });
    }
    for (const ref of refs) {
      const key = `${ref.assetId}:${ref.assetVersion}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const resolveAsset = op.resolveAsset;
      let resolved: Awaited<ReturnType<NonNullable<FrozenOperation["resolveAsset"]>>> = null;
      try {
        resolved = await resolveAsset(ref.assetId, ref.assetVersion);
      } catch {
        resolved = null;
      }
      if (resolved !== null) {
        if (!resolved.mime.startsWith("image/"))
          throw new Error("Non-image asset cannot be sent as an image model input");
        blocks.push({
          type: "image",
          data: resolved.data.toString("base64"),
          mimeType: resolved.mime,
        });
      }
    }
    return blocks;
  }

  async *run(op: FrozenOperation, signal: AbortSignal): AsyncGenerator<ModelEvent> {
    if (this.resolved === null) {
      yield {
        type: "error",
        code: "MODEL_NOT_FOUND",
        message: `model ${this.options.provider}/${this.options.modelId} not found in pi-ai catalog；自定义端点请配置 baseUrl`,
      };
      return;
    }
    const { model, useCompat } = this.resolved;
    const content = await this.buildUserContent(op);
    const message: UserMessage = { role: "user", content, timestamp: Date.now() };
    const requestOptions: SimpleStreamOptions = { signal };
    const level = modelThinkingLevel(this.options, model);
    if (level !== "off") requestOptions.reasoning = level;
    if (this.options.apiKey !== undefined) requestOptions.apiKey = this.options.apiKey;
    const context = { systemPrompt: buildSystemPrompt(op.type, op.language), messages: [message] };
    const stream = await retryTimedOutRequests(
      meteredStream(
        useCompat ? compatStreamSimple : builtinModels().streamSimple.bind(builtinModels()),
      ),
    )(model, context, requestOptions);
    let text = "";
    let failed: { code: string; message: string } | null = null;
    try {
      for await (const event of stream) {
        if (signal.aborted) return;
        if (event.type === "text_delta") {
          text += event.delta;
        } else if (event.type === "error") {
          if (event.reason === "aborted" || signal.aborted) return;
          failed = {
            code: "MODEL_ERROR",
            message: event.error.errorMessage ?? "model stream failed",
          };
          break;
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      failed = { code: "MODEL_ERROR", message: (err as Error).message };
    }
    if (signal.aborted) return;
    if (failed !== null) {
      yield {
        type: "error",
        code: failed.code,
        message: modelErrorMessage(failed.message, this.options),
      };
      return;
    }
    const parsed = parseModelOutput(text, op.type);
    if (!parsed.ok) {
      yield { type: "error", code: parsed.code, message: parsed.message };
      return;
    }
    for (const [itemIndex, item] of parsed.items.entries()) {
      if (signal.aborted) return;
      if (op.type === "compress") {
        yield { type: "summary.segment", field: "title", segmentIndex: 0, text: item.title };
        yield { type: "summary.segment", field: "summary", segmentIndex: 0, text: item.text };
      } else {
        yield { type: "item.start", itemIndex, title: item.title };
        yield { type: "item.segment", itemIndex, text: item.text };
        yield { type: "item.complete", itemIndex };
      }
    }
  }
}

export function resolveModel(
  options: PiOptions,
  found: Model<Api> | null,
  supportsVision: boolean,
): ResolvedModel | null {
  const api = options.api ?? found?.api ?? "openai-completions";
  const baseUrl = options.baseUrl ?? found?.baseUrl;
  if (!baseUrl) return null;
  const compatible = found?.api === api ? found : null;
  const model: Model<Api> = {
    ...(compatible ?? {
      id: options.modelId,
      name: options.modelId,
      provider: options.provider,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      // Directory-less endpoints must opt into an explicit limit. 32k is the
      // broadly supported default and avoids cutting off reasoning at 8k.
      maxTokens: 32768,
    }),
    contextWindow: options.contextWindow ?? compatible?.contextWindow ?? 128_000,
    api,
    baseUrl,
    reasoning: options.reasoning ?? compatible?.reasoning ?? false,
    input: supportsVision ? ["text", "image"] : ["text"],
  };
  if (
    (api === "openai-completions" || api === "openai-responses") &&
    (!found || endpointIdentity(baseUrl) !== endpointIdentity(found.baseUrl))
  ) {
    // Reasoning capability does not imply support for OpenAI's developer role.
    model.compat = { ...model.compat, supportsDeveloperRole: false };
  }
  model.maxTokens = Math.min(
    options.maxOutputTokens ?? model.maxTokens,
    Math.max(256, model.contextWindow - 1024),
  );
  if (options.thinkingLevels) {
    const levels = options.thinkingLevels;
    model.thinkingLevelMap = Object.fromEntries(
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [
        level,
        levels.includes(level as import("@intrica/contracts").ModelThinkingLevel)
          ? (model.thinkingLevelMap?.[level as import("@intrica/contracts").ModelThinkingLevel] ??
            (level === "off" ? "none" : level))
          : null,
      ]),
    );
  }
  return { model, useCompat: options.api !== undefined || found === null };
}
