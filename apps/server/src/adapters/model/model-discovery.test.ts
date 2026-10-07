import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import { discoverModels } from "./model-discovery.js";
import type { ModelConfig } from "./types.js";

let server: Server;
let config: Extract<ModelConfig, { kind: "pi" }>;
let payload: unknown;
let status: number;
let request: { url?: string; headers: Record<string, unknown> };
beforeEach(async () => {
  status = 200;
  server = createServer((req, res) => {
    request = { url: req.url ?? "", headers: req.headers };
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  config = {
    kind: "pi",
    provider: "custom",
    api: "openai-completions",
    modelId: "unused",
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    apiKey: "test-secret",
  };
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
it("discovers real model IDs and honors endpoint efforts before catalog/presets", async () => {
  payload = {
    data: [
      { id: "custom-reasoner", reasoning_efforts: ["none", "high", "xhigh", "max"] },
      { id: "plain", capabilities: { reasoning: false } },
      { id: "unlisted" },
      { id: "unlisted" },
      { id: "reasoning-only", reasoning: true },
    ],
  };
  const value = await discoverModels(config);
  expect(request.url).toBe("/v1/models");
  expect(request.headers.authorization).toBe("Bearer test-secret");
  expect(value.models).toHaveLength(4);
  expect(value.models[3]?.capabilitySource).toBe("preset");
  expect(value.models[0]).toMatchObject({
    thinkingLevels: ["off", "high", "xhigh", "max"],
    capabilitySource: "endpoint",
  });
  expect(value.models[1]).toMatchObject({ thinkingLevels: ["off"], reasoning: false });
  expect(value.models[2]).toMatchObject({
    thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    capabilitySource: "preset",
  });
  expect(JSON.stringify(value)).not.toContain("test-secret");
});
it("uses Anthropic and Gemini list routes and authentication headers", async () => {
  payload = { data: [{ id: "claude-proxy", thinking_levels: ["low", "high"] }] };
  await discoverModels({ ...config, api: "anthropic-messages" });
  expect(request.url).toBe("/v1/models");
  expect(request.headers["x-api-key"]).toBe("test-secret");
  payload = {
    models: [
      { name: "models/custom-gemini", supportedGenerationMethods: ["generateContent"] },
      { name: "models/embedding", supportedGenerationMethods: ["embedContent"] },
    ],
    nextPageToken: "more",
  };
  const list = await discoverModels({
    ...config,
    api: "google-generative-ai",
    baseUrl: config.baseUrl!.replace(/\/v1$/, ""),
  });
  expect(request.url).toBe("/v1beta/models");
  expect(request.headers["x-goog-api-key"]).toBe("test-secret");
  expect(list.models.map((m) => m.id)).toEqual(["custom-gemini"]);
  expect(list.truncated).toBe(true);
});
it("rejects failed discovery without reflecting a credential-bearing response", async () => {
  status = 401;
  payload = { error: "test-secret rejected" };
  await expect(discoverModels(config)).rejects.toThrow("HTTP 401");
});
