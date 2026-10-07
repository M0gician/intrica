import {
  DEFAULT_THINKING_LEVELS,
  type DiscoveredModel,
  type ModelDiscovery,
  type ModelThinkingLevel,
} from "@intrica/contracts";
import { modelCatalog } from "./model-catalog.js";
import type { ModelConfig } from "./types.js";

export async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("服务未返回内容");
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > maxBytes) throw new Error("服务返回内容过大");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
const normalizeLevel = (value: unknown): ModelThinkingLevel | null => {
  const level = value === "none" ? "off" : value;
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(level))
    ? (level as ModelThinkingLevel)
    : null;
};
export class ModelDiscoveryHttpError extends Error {
  constructor(readonly status: number) {
    super(`Model list request failed (HTTP ${status}).`);
  }
}
export async function discoverModels(
  config: Extract<ModelConfig, { kind: "pi" }>,
  signal?: AbortSignal,
): Promise<ModelDiscovery> {
  const base = config.baseUrl!.replace(/\/+$/, "");
  const url = new URL(
    config.api === "anthropic-messages"
      ? `${base.endsWith("/v1") ? base : `${base}/v1`}/models`
      : config.api === "google-generative-ai"
        ? `${/\/v1(beta)?$/.test(base) ? base : `${base}/v1beta`}/models`
        : `${base}/models`,
  );
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.api === "anthropic-messages") {
    headers["x-api-key"] = config.apiKey!;
    headers["anthropic-version"] = "2023-06-01";
  } else if (config.api === "google-generative-ai") headers["x-goog-api-key"] = config.apiKey!;
  else headers.Authorization = `Bearer ${config.apiKey}`;
  const response = await fetch(url, {
    headers,
    redirect: "error",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ModelDiscoveryHttpError(response.status);
  }
  const json = JSON.parse(await boundedText(response, 2 * 1024 * 1024));
  const rows = json.data ?? json.models;
  if (!Array.isArray(rows))
    throw new Error("endpoint 未返回可识别的模型列表，仍可手动填写模型 ID。");
  const catalog = modelCatalog();
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const raw of rows.slice(0, 2000)) {
    if (!raw || typeof raw !== "object") continue;
    const id = String(raw.id ?? raw.name ?? "").replace(/^models\//, "");
    if (!id || id.length > 200 || seen.has(id)) continue;
    if (
      Array.isArray(raw.supportedGenerationMethods) &&
      !raw.supportedGenerationMethods.includes("generateContent")
    )
      continue;
    seen.add(id);
    const known =
      catalog.find((m) => m.id === id && m.api === config.api && m.provider === config.provider) ??
      catalog.find((m) => m.id === id && m.api === config.api);
    const metadata =
      raw.thinking_levels ??
      raw.reasoning_efforts ??
      raw.supported_reasoning_efforts ??
      raw.capabilities?.thinking_levels ??
      raw.capabilities?.reasoning_efforts ??
      raw.reasoning?.efforts;
    const normalized = Array.isArray(metadata)
      ? [
          ...new Set(
            metadata.map(normalizeLevel).filter((x): x is ModelThinkingLevel => x !== null),
          ),
        ]
      : [];
    const declaredReasoning =
      typeof raw.reasoning === "boolean"
        ? raw.reasoning
        : typeof raw.capabilities?.reasoning === "boolean"
          ? raw.capabilities.reasoning
          : undefined;
    const compatibleCatalog =
      known && (declaredReasoning !== true || known.reasoning) ? known : undefined;
    const levels = normalized.length
      ? normalized
      : declaredReasoning === false
        ? ["off" as const]
        : (compatibleCatalog?.thinkingLevels ?? [...DEFAULT_THINKING_LEVELS]);
    models.push({
      id,
      name: String(raw.displayName ?? raw.display_name ?? id).slice(0, 200),
      ...(Number.isInteger(raw.context_tokens) && raw.context_tokens > 0
        ? { contextWindow: raw.context_tokens }
        : {}),
      ...(Number.isInteger(raw.output_tokens) && raw.output_tokens > 0
        ? { maxOutputTokens: raw.output_tokens }
        : {}),
      thinkingLevels: levels,
      capabilitySource:
        normalized.length || declaredReasoning === false
          ? "endpoint"
          : compatibleCatalog
            ? "catalog"
            : "preset",
      reasoning: levels.some((level) => level !== "off"),
      supportsVision:
        typeof raw.capabilities?.vision === "boolean"
          ? raw.capabilities.vision
          : Array.isArray(raw.input_modalities)
            ? raw.input_modalities.includes("image")
            : (known?.supportsVision ?? false),
    });
  }
  return {
    models,
    truncated:
      rows.length > 2000 || Boolean(json.has_more || json.nextPageToken || json.next_page_token),
  };
}
