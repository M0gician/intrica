import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, configFilePath, loadFileConfig, resolveModelConfig } from "./config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "intrica-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(content: unknown): string {
  const path = join(dir, "intrica.config.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

describe("loadFileConfig", () => {
  it("文件不存在时返回空配置", () => {
    expect(loadFileConfig(join(dir, "missing.json"))).toEqual({});
  });

  it("解析合法配置", () => {
    const path = writeConfig({
      model: {
        kind: "pi",
        provider: "openai",
        modelId: "gpt-4o-mini",
        apiKeyEnv: "OPENAI_API_KEY",
        baseUrl: "http://127.0.0.1:11434/v1",
        supportsVision: false,
        mock: { streamDelayMs: 0, supportsVision: false },
      },
    });
    expect(loadFileConfig(path)).toEqual({
      model: {
        kind: "pi",
        provider: "openai",
        modelId: "gpt-4o-mini",
        apiKeyEnv: "OPENAI_API_KEY",
        baseUrl: "http://127.0.0.1:11434/v1",
        supportsVision: false,
        mock: { streamDelayMs: 0, supportsVision: false },
      },
    });
  });

  it("非法 JSON 报 ConfigError", () => {
    const path = writeConfig("{ not json");
    expect(() => loadFileConfig(path)).toThrow(ConfigError);
  });

  it.each([
    [{ model: "x" }, "model 必须是对象"],
    [{ model: { kind: "gpt" } }, 'model.kind 必须是 "mock" 或 "pi"'],
    [{ model: { provider: 1 } }, "model.provider 必须是字符串"],
    [{ model: { baseUrl: "not a url" } }, "model.baseUrl 不是合法 URL"],
    [{ model: { supportsVision: "yes" } }, "model.supportsVision 必须是布尔值"],
    [{ model: { mock: { streamDelayMs: -1 } } }, "model.mock.streamDelayMs 必须是非负数字"],
    [{ model: { mock: { supportsVision: 1 } } }, "model.mock.supportsVision 必须是布尔值"],
  ])("字段校验：%j", (raw, message) => {
    const path = writeConfig(raw);
    expect(() => loadFileConfig(path)).toThrow(message as string);
  });
});

describe("resolveModelConfig", () => {
  it("默认 mock", () => {
    expect(resolveModelConfig({})).toEqual({
      kind: "mock",
      streamDelayMs: 40,
      supportsVision: true,
    });
  });

  it("文件提供 pi 配置（含 baseUrl 与 apiKeyEnv）", () => {
    const config = resolveModelConfig(
      { CUSTOM_KEY: "sk-from-env" },
      {
        model: {
          kind: "pi",
          provider: "custom",
          modelId: "my-model",
          apiKeyEnv: "CUSTOM_KEY",
          baseUrl: "http://127.0.0.1:9000/v1",
          supportsVision: true,
        },
      },
    );
    expect(config).toEqual({
      kind: "pi",
      provider: "custom",
      modelId: "my-model",
      apiKey: "sk-from-env",
      baseUrl: "http://127.0.0.1:9000/v1",
      supportsVision: true,
    });
  });

  it("环境变量覆盖文件", () => {
    const config = resolveModelConfig(
      {
        MODEL_KIND: "pi",
        MODEL_PROVIDER: "anthropic",
        MODEL_ID: "claude-sonnet-4-5",
        MODEL_API_KEY: "sk-env",
        MODEL_BASE_URL: "https://proxy.example.com/v1",
      },
      {
        model: {
          kind: "pi",
          provider: "custom",
          modelId: "my-model",
          apiKey: "sk-file",
          baseUrl: "http://127.0.0.1:9000/v1",
        },
      },
    );
    expect(config).toEqual({
      kind: "pi",
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      apiKey: "sk-env",
      baseUrl: "https://proxy.example.com/v1",
    });
  });

  it("apiKeyEnv 优先于 apiKey 明文；环境变量缺失时回退明文", () => {
    const withLookup = resolveModelConfig(
      { MY_KEY: "sk-lookup" },
      {
        model: {
          kind: "pi",
          provider: "p",
          modelId: "m",
          apiKey: "sk-literal",
          apiKeyEnv: "MY_KEY",
        },
      },
    );
    expect(withLookup).toMatchObject({ apiKey: "sk-lookup" });
    const fallback = resolveModelConfig(
      {},
      {
        model: {
          kind: "pi",
          provider: "p",
          modelId: "m",
          apiKey: "sk-literal",
          apiKeyEnv: "MY_KEY",
        },
      },
    );
    expect(fallback).toMatchObject({ apiKey: "sk-literal" });
  });

  it("kind=pi 缺 provider/modelId 时报 ConfigError", () => {
    expect(() => resolveModelConfig({ MODEL_KIND: "pi" }, {})).toThrow(/model\.provider 未配置/);
    expect(() => resolveModelConfig({ MODEL_KIND: "pi", MODEL_PROVIDER: "openai" }, {})).toThrow(
      /model\.modelId 未配置/,
    );
  });

  it("mock 参数可从文件读取", () => {
    const config = resolveModelConfig(
      {},
      { model: { kind: "mock", mock: { streamDelayMs: 0, supportsVision: false } } },
    );
    expect(config).toEqual({ kind: "mock", streamDelayMs: 0, supportsVision: false });
  });
});

describe("configFilePath", () => {
  it("INTRICA_CONFIG 覆盖默认路径", () => {
    expect(configFilePath({ INTRICA_CONFIG: "/tmp/x.json" }, dir)).toBe("/tmp/x.json");
  });

  it("从起始目录向上查找配置文件", () => {
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    const found = writeConfig({ model: { kind: "mock" } });
    expect(configFilePath({}, nested)).toBe(found);
  });

  it("都找不到时返回起始目录下的默认路径", () => {
    const empty = mkdtempSync(join(tmpdir(), "intrica-noconfig-"));
    expect(configFilePath({}, empty)).toBe(join(empty, "intrica.config.json"));
    rmSync(empty, { recursive: true, force: true });
  });
});
