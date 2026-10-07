import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { MODEL_PROTOCOLS } from "@intrica/contracts";
import { Type } from "typebox";
import {
  createCanvasAgent,
  discoverModels,
  ModelDiscoveryHttpError,
  modelCatalog,
} from "../adapters/model/index.js";
import type { ModelRegistry } from "../adapters/model/registry.js";
import { withModelUsage } from "../adapters/model/usage.js";
import type { AppInstance } from "../app.js";
import { promptLanguage, promptText } from "../prompt-language.js";

const level = Type.Union(
  (["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map((value) =>
    Type.Literal(value),
  ),
);
const input = Type.Object(
  {
    id: Type.Optional(Type.String({ maxLength: 100 })),
    endpointId: Type.String({ minLength: 1, maxLength: 100 }),
    expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    provider: Type.String({ minLength: 1, maxLength: 200 }),
    modelId: Type.String({ minLength: 1, maxLength: 200 }),
    api: Type.Union(MODEL_PROTOCOLS.map((value) => Type.Literal(value))),
    contextWindow: Type.Optional(Type.Integer({ minimum: 4096, maximum: 2000000 })),
    maxOutputTokens: Type.Optional(Type.Integer({ minimum: 256, maximum: 2000000 })),
    inputPricePerMillion: Type.Optional(Type.Number({ minimum: 0, maximum: 100000 })),
    outputPricePerMillion: Type.Optional(Type.Number({ minimum: 0, maximum: 100000 })),
    outputTokensPerSecond: Type.Optional(Type.Number({ minimum: 0, maximum: 1000000 })),
    reasoning: Type.Boolean(),
    supportsVision: Type.Boolean(),
    thinkingLevel: level,
    thinkingLevels: Type.Optional(
      Type.Array(level, { minItems: 1, maxItems: 7, uniqueItems: true }),
    ),
  },
  { additionalProperties: false },
);

export function registerModelSettingsRoutes(app: AppInstance, store: ModelRegistry) {
  app.register(async (instance) => {
    const server = instance.withTypeProvider<TypeBoxTypeProvider>();
    server.addHook("onRequest", async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
    });
    server.get("/api/v2/workspace/models", async () => store.view());
    server.post(
      "/api/v2/model-endpoints",
      {
        schema: {
          body: Type.Object(
            {
              id: Type.Optional(Type.String({ maxLength: 100 })),
              expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
              name: Type.String({ minLength: 1, maxLength: 200 }),
              baseUrl: Type.String({ minLength: 1, maxLength: 2000 }),
              apiKey: Type.Optional(Type.String({ maxLength: 8192 })),
            },
            { additionalProperties: false },
          ),
        },
      },
      (req) => store.saveEndpoint(req.body),
    );
    server.delete(
      "/api/v2/model-endpoints/:id",
      {
        schema: {
          params: Type.Object({ id: Type.String() }),
          querystring: Type.Object({ expectedRevision: Type.Integer({ minimum: 1 }) }),
        },
      },
      (req) => store.deleteEndpoint(req.params.id, req.query.expectedRevision),
    );
    server.get("/api/v2/workspace/models/catalog", async () => modelCatalog());
    server.post(
      "/api/v2/workspace/models",
      {
        schema: {
          body: input,
        },
      },
      async (request) => store.save(request.body),
    );
    server.post(
      "/api/v2/workspace/models/select",
      {
        schema: {
          body: Type.Object(
            {
              id: Type.Union([Type.String(), Type.Null()]),
              expectedSelectedId: Type.Union([Type.String(), Type.Null()]),
            },
            { additionalProperties: false },
          ),
        },
      },
      async (request) => store.select(request.body.id, request.body.expectedSelectedId),
    );
    server.delete(
      "/api/v2/workspace/models/:id",
      {
        schema: {
          params: Type.Object({ id: Type.String() }),
          querystring: Type.Object({ expectedRevision: Type.Integer({ minimum: 1 }) }),
        },
      },
      async (request) => store.delete(request.params.id, request.query.expectedRevision),
    );
    server.post(
      "/api/v2/workspace/models/discover",
      {
        schema: {
          body: Type.Pick(input, ["endpointId", "provider", "api"]),
        },
      },
      async (request, reply) => {
        const config = await store.connection(request.body);
        const abort = new AbortController();
        const stop = () => abort.abort();
        reply.raw.on("close", stop);
        try {
          return await discoverModels(config, abort.signal);
        } catch (error) {
          return reply.code(422).send({
            error: {
              code: "DISCOVERY_FAILED",
              message: "Could not load the model list.",
              ...(error instanceof ModelDiscoveryHttpError ? { upstreamStatus: error.status } : {}),
            },
          });
        } finally {
          reply.raw.off("close", stop);
        }
      },
    );
    server.post(
      "/api/v2/workspace/models/test",
      { schema: { body: input } },
      async (request, reply) => {
        const config = await store.testConfig(request.body);
        const agent = createCanvasAgent(config, "connection-test");
        const language = promptLanguage(request.headers["accept-language"]);
        agent.state.systemPrompt = promptText(
          language,
          "You are testing a model connection. Follow the requested output format.",
          "你正在测试模型连接，请遵循要求的输出格式。",
        );
        const timer = setTimeout(() => agent.abort(), 30000);
        const stop = () => agent.abort();
        reply.raw.on("close", stop);
        try {
          agent.state.tools = [];
          await withModelUsage(
            {
              db: store.db,
              purpose: "connection_test",
              model: {
                config,
                endpointId: request.body.endpointId,
                ...(request.body.id ? { profileId: request.body.id } : {}),
              },
            },
            () => agent.prompt(promptText(language, "Reply with OK only.", "请仅回复 OK。")),
          );
          const last = agent.state.messages.at(-1);
          if (
            last?.role !== "assistant" ||
            last.stopReason === "error" ||
            last.stopReason === "aborted"
          ) {
            return reply.code(422).send({
              error: {
                code: "CONNECTION_FAILED",
                message:
                  "连接测试失败。请检查 endpoint、协议、模型 ID、API key 与思考强度，或稍后重试。",
              },
            });
          }
          return { ok: true };
        } catch {
          // Provider errors can echo credentials or request payloads; never return them here.
          return reply.code(422).send({
            error: { code: "CONNECTION_FAILED", message: "连接测试失败。请检查服务配置与网络。" },
          });
        } finally {
          reply.raw.off("close", stop);
          clearTimeout(timer);
          agent.abort();
        }
      },
    );
  });
}
