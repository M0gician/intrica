import { resolve } from "node:path";
import multipart from "@fastify/multipart";
import { type TypeBoxTypeProvider, TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import { GRAPH_PROTOCOL, MAX_UPLOAD_BYTES } from "@intrica/contracts";
import Fastify from "fastify";
import { Type } from "typebox";
import { HostClient } from "./adapters/host/rpc.js";
import { DomainError } from "./adapters/postgres/database.js";
import { authorizedRequest, sessionCookie, tokenIsValid } from "./auth.js";
import { createKernel } from "./composition.js";
import { type ApiConfig, authenticateConfig, configFromEnv } from "./config.js";
import { superviseWorker } from "./entrypoints/supervisor.js";
import { registerConversations } from "./http/conversations.js";
import { registerGraph } from "./http/graph.js";
import { registerModelSettingsRoutes } from "./http/models.js";
import { registerSettings } from "./http/settings.js";
import { initializeStreams, registerStreams } from "./http/streams.js";
import { registerUpdates, serverVersion } from "./http/updates.js";
import { registerWebRoutes } from "./http/web.js";
import { registerWorkspace } from "./http/workspace.js";
import { loadServerIdentity } from "./identity.js";

const createApp = () =>
  Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    forceCloseConnections: true,
  }).withTypeProvider<TypeBoxTypeProvider>();
export type AppInstance = ReturnType<typeof createApp>;
export type BuildServerOptions = Partial<ApiConfig>;
export async function buildServer(options: BuildServerOptions = {}) {
  const config = authenticateConfig({
    ...configFromEnv(),
    ...options,
    dataDir: resolve(options.dataDir ?? configFromEnv().dataDir),
  });
  const app = createApp();
  app.setValidatorCompiler(TypeBoxValidatorCompiler);
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
  app.setErrorHandler((error, request, reply) => {
    const e = error as Error & { statusCode?: number };
    const known = error instanceof DomainError;
    const statuses: Record<string, number> = {
      NOT_FOUND: 404,
      FORBIDDEN: 403,
      VERSION_CONFLICT: 409,
      ACCEPT_CONFLICT: 409,
      UNDO_CONFLICT: 409,
      IDEMPOTENCY_CONFLICT: 409,
      STALE_EXECUTION: 409,
      RESET_REQUIRED: 410,
      QUEUE_FULL: 429,
      TERMINAL_LIMIT: 429,
      HOST_UNAVAILABLE: 503,
      ASSET_INVALID: 415,
    };
    const status = known
      ? (statuses[error.code] ?? 422)
      : typeof e.statusCode === "number"
        ? e.statusCode
        : 500;
    if (status >= 500)
      console.error("[http]", request.id, request.method, request.routeOptions.url, e.message);
    void reply.code(status).send({
      error: {
        code: known ? error.code : status === 400 ? "VALIDATION" : "INTERNAL",
        message: known || status === 400 ? e.message : "服务暂时不可用",
        ...(known && error.details ? { details: error.details } : {}),
      },
    });
  });
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    const pathname = req.url.split("?", 1)[0];
    if (
      ["/api/v2/health", "/api/v2/ready", "/api/v2/server", "/api/v2/session"].includes(pathname!)
    )
      return;
    if (!authorizedRequest(req, config.accessToken))
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "需要登录 Intrica" } });
    if (!["GET", "HEAD"].includes(req.method) && req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host)
          return reply.code(403).send({ error: { code: "FORBIDDEN", message: "请求来源不匹配" } });
      } catch {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "请求来源无效" } });
      }
    }
  });
  const kernel = await createKernel(config);
  let supervisor: Awaited<ReturnType<typeof superviseWorker>> | undefined;
  let closing = false;
  app.addHook("onReady", async () => {
    if (config.worker) supervisor = await superviseWorker(config);
  });
  app.addHook("preClose", async () => {
    closing = true;
  });
  app.addHook("onClose", async () => {
    try {
      await supervisor?.close();
    } finally {
      await kernel.db.close();
    }
  });
  try {
    const identity = loadServerIdentity(config.dataDir);
    app.get("/api/v2/health", async () => ({ ok: true, status: "healthy" }));
    app.get("/api/v2/ready", async (_req, reply) => {
      try {
        if (closing) throw new Error("closing");
        await kernel.db.pool.query("select 1");
        if (config.worker) await new HostClient(config.dataDir).call("ping", {});
        return { ok: true, status: "ready" };
      } catch {
        return reply.code(503).send({ ok: false, status: "unavailable" });
      }
    });
    app.get("/api/v2/server", async () => ({
      id: identity.id,
      name: config.serverName,
      version: serverVersion(),
      commit: process.env.INTRICA_COMMIT ?? null,
      apiVersion: "v2",
      graphProtocol: GRAPH_PROTOCOL,
      web: { enabled: Boolean(config.webRoot) },
    }));
    app.get("/api/v2/capabilities", async () => ({
      server: { files: true, terminals: true, assets: true, models: true },
      agent: { enabled: true, canvas: true, browserAutomation: false },
      desktop: { nativeBrowser: false, nativeNotifications: false, filePicker: false },
    }));
    app.get("/api/v2/session", async (req, reply) => {
      if (!authorizedRequest(req, config.accessToken))
        return reply.code(401).send({ authenticated: false });
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (tokenIsValid(bearer, config.accessToken))
        reply.header("Set-Cookie", sessionCookie(config.accessToken, req.protocol === "https"));
      return { authenticated: true, protected: true };
    });
    app.post(
      "/api/v2/session",
      { schema: { body: Type.Object({ token: Type.String({ minLength: 1, maxLength: 512 }) }) } },
      async (req, reply) => {
        if (!tokenIsValid(req.body.token, config.accessToken))
          return reply.code(401).send({ authenticated: false });
        reply.header("Set-Cookie", sessionCookie(config.accessToken, req.protocol === "https"));
        return { authenticated: true, protected: true };
      },
    );
    initializeStreams(app);
    registerSettings(app, kernel);
    registerUpdates(app, config);
    registerGraph(app, kernel);
    registerConversations(app, kernel);
    registerWorkspace(app, kernel, identity.id);
    registerStreams(app, kernel);
    registerModelSettingsRoutes(app, kernel.models);
    registerWebRoutes(app, config.webRoot);
    return Object.assign(app, { kernel, runtimeConfig: config });
  } catch (error) {
    await app.close().catch((cleanupError) => console.error("[server:cleanup]", cleanupError));
    throw error;
  }
}
