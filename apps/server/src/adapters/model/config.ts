import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ModelConfig } from "./types.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** intrica.config.json 的模型节；全部字段可选，与环境变量合并后生效。 */
export type ModelFileConfig = {
  kind?: "mock" | "pi";
  provider?: string;
  modelId?: string;
  apiKey?: string;
  /** 从指定环境变量读取 API key（优先于 apiKey 明文）。 */
  apiKeyEnv?: string;
  baseUrl?: string;
  supportsVision?: boolean;
  api?: Extract<ModelConfig, { kind: "pi" }>["api"];
  reasoning?: boolean;
  thinkingLevel?: Extract<ModelConfig, { kind: "pi" }>["thinkingLevel"];
  contextWindow?: number;
  maxOutputTokens?: number;
  mock?: {
    streamDelayMs?: number;
    supportsVision?: boolean;
  };
};

export type IntricaFileConfig = {
  model?: ModelFileConfig;
};

export const CONFIG_FILE_NAME = "intrica.config.json";

/**
 * 配置文件路径：INTRICA_CONFIG 显式指定优先；否则从 startDir 起向上查找
 * （兼容从仓库根或 apps/server 等子目录启动）；都找不到时返回 startDir 下的默认路径。
 */
export function configFilePath(
  env: NodeJS.ProcessEnv = process.env,
  startDir: string = process.cwd(),
): string {
  if (env.INTRICA_CONFIG !== undefined && env.INTRICA_CONFIG !== "") {
    return env.INTRICA_CONFIG;
  }
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return join(resolve(startDir), CONFIG_FILE_NAME);
    dir = parent;
  }
}

/** 读取配置文件；文件不存在时返回空配置（环境变量仍可独立工作）。 */
export function loadFileConfig(path: string): IntricaFileConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError(`无法读取配置文件 ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`配置文件 ${path} 不是合法 JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`配置文件 ${path} 必须是 JSON 对象`);
  }
  return validateFileConfig(parsed as Record<string, unknown>, path);
}

function validateFileConfig(raw: Record<string, unknown>, path: string): IntricaFileConfig {
  const fail = (msg: string): never => {
    throw new ConfigError(`配置文件 ${path}: ${msg}`);
  };
  const out: IntricaFileConfig = {};
  if (raw.model === undefined) return out;
  const model = raw.model;
  if (typeof model !== "object" || model === null || Array.isArray(model)) {
    fail("model 必须是对象");
  }
  const m = model as Record<string, unknown>;
  const fm: ModelFileConfig = {};
  if (m.kind !== undefined) {
    if (m.kind !== "mock" && m.kind !== "pi") fail('model.kind 必须是 "mock" 或 "pi"');
    fm.kind = m.kind as "mock" | "pi";
  }
  for (const key of ["provider", "modelId", "apiKey", "apiKeyEnv", "baseUrl"] as const) {
    const value = m[key];
    if (value !== undefined) {
      if (typeof value !== "string") fail(`model.${key} 必须是字符串`);
      if (value !== "") fm[key] = value as string;
    }
  }
  if (m.baseUrl !== undefined && fm.baseUrl !== undefined) {
    try {
      new URL(fm.baseUrl);
    } catch {
      fail(`model.baseUrl 不是合法 URL: ${fm.baseUrl}`);
    }
  }
  if (m.supportsVision !== undefined) {
    if (typeof m.supportsVision !== "boolean") fail("model.supportsVision 必须是布尔值");
    fm.supportsVision = m.supportsVision as boolean;
  }
  if (m.api !== undefined) {
    if (
      ![
        "openai-completions",
        "openai-responses",
        "anthropic-messages",
        "google-generative-ai",
      ].includes(String(m.api))
    )
      fail("model.api 不支持");
    fm.api = m.api as ModelFileConfig["api"] & string;
  }
  if (m.reasoning !== undefined) {
    if (typeof m.reasoning !== "boolean") fail("model.reasoning 必须是布尔值");
    fm.reasoning = m.reasoning as boolean;
  }
  if (m.thinkingLevel !== undefined) {
    if (
      !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(m.thinkingLevel))
    )
      fail("model.thinkingLevel 不支持");
    fm.thinkingLevel = m.thinkingLevel as ModelFileConfig["thinkingLevel"] & string;
  }
  for (const key of ["contextWindow", "maxOutputTokens"] as const) {
    const value = m[key];
    if (value !== undefined) {
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < (key === "contextWindow" ? 4096 : 256) ||
        value > 2000000
      )
        fail(`model.${key} 必须是正整数`);
      (fm as Record<string, unknown>)[key] = value;
    }
  }
  if (
    fm.contextWindow !== undefined &&
    fm.maxOutputTokens !== undefined &&
    fm.maxOutputTokens > fm.contextWindow
  )
    fail("model.maxOutputTokens 不能超过 model.contextWindow");
  if (m.mock !== undefined) {
    if (typeof m.mock !== "object" || m.mock === null || Array.isArray(m.mock)) {
      fail("model.mock 必须是对象");
    }
    const mock = m.mock as Record<string, unknown>;
    const fmock: NonNullable<ModelFileConfig["mock"]> = {};
    if (mock.streamDelayMs !== undefined) {
      if (typeof mock.streamDelayMs !== "number" || mock.streamDelayMs < 0) {
        fail("model.mock.streamDelayMs 必须是非负数字");
      }
      fmock.streamDelayMs = mock.streamDelayMs as number;
    }
    if (mock.supportsVision !== undefined) {
      if (typeof mock.supportsVision !== "boolean") {
        fail("model.mock.supportsVision 必须是布尔值");
      }
      fmock.supportsVision = mock.supportsVision as boolean;
    }
    fm.mock = fmock;
  }
  out.model = fm;
  return out;
}

function envBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return value === "true" || value === "1";
}

/**
 * 合并模型配置：环境变量 > 配置文件 > 内置默认。
 * 未配置或历史模拟配置返回 null；测试模拟只能通过内部依赖注入。
 */
export function resolveModelConfig(
  env: NodeJS.ProcessEnv,
  file: IntricaFileConfig = {},
): ModelConfig | null {
  const m = file.model ?? {};
  const kind = env.MODEL_KIND ?? m.kind ?? (env.MODEL_ID || m.modelId ? "pi" : undefined);
  if (kind === undefined || kind === "mock") return null;
  if (kind === "pi") {
    const provider = env.MODEL_PROVIDER ?? m.provider;
    const modelId = env.MODEL_ID ?? m.modelId;
    if (!provider?.trim() || !modelId?.trim()) return null;
    const config: Extract<ModelConfig, { kind: "pi" }> = { kind: "pi", provider, modelId };
    const keyFromEnvVar = m.apiKeyEnv !== undefined ? env[m.apiKeyEnv] : undefined;
    const apiKey =
      env.MODEL_API_KEY ?? (keyFromEnvVar !== "" ? keyFromEnvVar : undefined) ?? m.apiKey;
    if (apiKey !== undefined && apiKey !== "") config.apiKey = apiKey;
    const baseUrl = env.MODEL_BASE_URL ?? m.baseUrl;
    if (baseUrl !== undefined && baseUrl !== "") config.baseUrl = baseUrl;
    const supportsVision = envBool(env.MODEL_SUPPORTS_VISION) ?? m.supportsVision;
    if (supportsVision !== undefined) config.supportsVision = supportsVision;
    if (m.api !== undefined) config.api = m.api;
    if (m.reasoning !== undefined) config.reasoning = m.reasoning;
    if (m.thinkingLevel !== undefined) config.thinkingLevel = m.thinkingLevel;
    if (m.contextWindow !== undefined) config.contextWindow = m.contextWindow;
    if (m.maxOutputTokens !== undefined) config.maxOutputTokens = m.maxOutputTokens;
    return config;
  }
  throw new ConfigError(`Unsupported model kind: ${JSON.stringify(kind)}`);
}
