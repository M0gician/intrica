import type { Api, Model } from "@earendil-works/pi-ai";
import { endpointIdentity } from "@intrica/contracts";
import type { ModelConfig } from "./types.js";
export type PiOptions = Omit<Extract<ModelConfig, { kind: "pi" }>, "kind">;
export type ResolvedModel = { model: Model<Api>; useCompat: boolean };
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
