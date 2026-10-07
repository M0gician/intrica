import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { MODEL_PROTOCOLS, type ModelProfileInput } from "@intrica/contracts";
import { DomainError } from "../postgres/database.js";
import { modelCapabilities } from "./model-catalog.js";
import type { ModelConfig } from "./types.js";

const fail = (message: string): never => {
  throw new DomainError("VALIDATION", message);
};
export function initialModelProfile(config: ModelConfig): ModelProfileInput | null {
  if (config.kind === "mock") return null;
  const model = builtinModels().getModel(config.provider, config.modelId);
  const api = config.api ?? model?.api ?? "openai-completions";
  const baseUrl = config.baseUrl ?? model?.baseUrl;
  if (!baseUrl || !MODEL_PROTOCOLS.includes(api as ModelProfileInput["api"])) return null;
  return {
    id: "startup",
    name: "Startup model",
    provider: config.provider,
    modelId: config.modelId,
    api: api as ModelProfileInput["api"],
    baseUrl,
    apiKey: config.apiKey ?? "",
    reasoning: config.reasoning ?? model?.reasoning ?? false,
    supportsVision: config.supportsVision ?? model?.input.includes("image") ?? false,
    thinkingLevel: modelCapabilities(config).thinkingLevel,
    ...(config.contextWindow ? { contextWindow: config.contextWindow } : {}),
    ...(config.maxOutputTokens ? { maxOutputTokens: config.maxOutputTokens } : {}),
  };
}
export function normalizeModelProfile(input: ModelProfileInput) {
  const profile = {
    ...input,
    id: input.id ?? "",
    apiKey: input.apiKey ?? "",
    name: input.name.trim(),
    modelId: input.modelId.trim(),
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
  };
  if (
    profile.contextWindow !== undefined &&
    (!Number.isInteger(profile.contextWindow) ||
      profile.contextWindow < 4096 ||
      profile.contextWindow > 2000000)
  )
    fail("上下文窗口需为 4096–2000000 tokens");
  if (
    profile.maxOutputTokens !== undefined &&
    (!Number.isInteger(profile.maxOutputTokens) ||
      profile.maxOutputTokens < 256 ||
      profile.maxOutputTokens > 2000000)
  )
    fail("最大输出需为 256–2000000 tokens");
  if (
    profile.contextWindow !== undefined &&
    profile.maxOutputTokens !== undefined &&
    profile.maxOutputTokens > profile.contextWindow
  )
    fail("最大输出不能超过上下文窗口");
  for (const key of [
    "inputPricePerMillion",
    "outputPricePerMillion",
    "outputTokensPerSecond",
  ] as const)
    if (profile[key] !== undefined && (!Number.isFinite(profile[key]) || profile[key] < 0))
      fail("模型薪酬和行动效率参数必须是非负数字");
  for (const key of ["name", "provider", "modelId", "baseUrl"] as const)
    if (
      typeof profile[key] !== "string" ||
      !profile[key].trim() ||
      profile[key].length > (key === "baseUrl" ? 2000 : 200)
    )
      fail("请填写有效的名称、endpoint 和模型 ID");
  if (
    !MODEL_PROTOCOLS.includes(profile.api) ||
    typeof profile.reasoning !== "boolean" ||
    typeof profile.supportsVision !== "boolean" ||
    typeof profile.apiKey !== "string" ||
    profile.apiKey.length > 8192
  )
    fail("模型配置格式无效");
  if (
    profile.thinkingLevels &&
    (!Array.isArray(profile.thinkingLevels) ||
      !profile.thinkingLevels.length ||
      profile.thinkingLevels.length > 7 ||
      new Set(profile.thinkingLevels).size !== profile.thinkingLevels.length ||
      profile.thinkingLevels.some(
        (level) => !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level),
      ))
  )
    fail("思考档位配置无效");
  let url: URL;
  try {
    url = new URL(profile.baseUrl);
  } catch {
    return fail("endpoint 必须是完整的 HTTP(S) 地址");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    fail("endpoint 不应包含账号、密码、查询参数或片段");
  try {
    modelCapabilities({ kind: "pi", ...profile });
  } catch {
    fail("此模型不支持所选思考强度");
  }
  return profile;
}
