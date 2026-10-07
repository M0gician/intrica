import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  MODEL_PROTOCOLS,
  type ModelCatalogEntry,
  type ModelThinkingLevel,
} from "@intrica/contracts";
import { resolveModel } from "./pi.js";
import type { ModelConfig } from "./types.js";

export function modelThinkingLevel(
  options: { thinkingLevel?: ModelThinkingLevel },
  model: Model<Api>,
): ModelThinkingLevel {
  const levels = getSupportedThinkingLevels(model);
  const level = options.thinkingLevel ?? (levels.includes("medium") ? "medium" : levels[0]!);
  if (!levels.includes(level)) throw new Error("此模型不支持所选思考强度");
  return level;
}

export function modelCapabilities(config: ModelConfig) {
  if (config.kind === "mock")
    return {
      thinkingLevel: "off" as const,
      thinkingLevels: ["off" as const],
      supportsVision: config.supportsVision,
    };
  const found = builtinModels().getModel(config.provider, config.modelId) ?? null;
  const resolved = resolveModel(
    config,
    found,
    config.supportsVision ?? found?.input.includes("image") ?? false,
  );
  if (!resolved) throw new Error("找不到模型，请填写 endpoint 和模型 ID");
  return {
    supportsVision: resolved.model.input.includes("image"),
    thinkingLevel: modelThinkingLevel(config, resolved.model),
    thinkingLevels: getSupportedThinkingLevels(resolved.model),
  };
}

export function modelCatalog(): ModelCatalogEntry[] {
  const models = builtinModels();
  return models
    .getModels()
    .filter(
      (model) =>
        (MODEL_PROTOCOLS as readonly string[]).includes(model.api) &&
        !["github-copilot"].includes(model.provider),
    )
    .map((model) => ({
      provider: model.provider,
      providerName: models.getProvider(model.provider)?.name ?? model.provider,
      id: model.id,
      name: model.name,
      api: model.api as ModelCatalogEntry["api"],
      baseUrl: model.baseUrl,
      reasoning: model.reasoning,
      supportsVision: model.input.includes("image"),
      thinkingLevels: getSupportedThinkingLevels(model),
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxTokens,
      ...(model.cost.input >= 0 ? { inputPricePerMillion: model.cost.input } : {}),
      ...(model.cost.output >= 0 ? { outputPricePerMillion: model.cost.output } : {}),
    }));
}

export function modelErrorMessage(message: string, config: { apiKey?: string }): string {
  return (config.apiKey ? message.replaceAll(config.apiKey, "[密钥已隐藏]") : message).slice(
    0,
    1600,
  );
}

export function modelContextWindow(config: ModelConfig) {
  const found =
    config.kind === "pi" ? builtinModels().getModel(config.provider, config.modelId) : null;
  const known = config.kind === "pi" && config.api && found?.api !== config.api ? null : found;
  return {
    contextWindow:
      config.kind === "pi" ? (config.contextWindow ?? known?.contextWindow ?? 128000) : 128000,
    windowSource:
      config.kind === "pi" && config.contextWindow
        ? ("configured" as const)
        : known
          ? ("catalog" as const)
          : ("preset" as const),
  };
}
