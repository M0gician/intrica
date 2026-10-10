import { setTimeout as delay } from "node:timers/promises";
import {
  applyMessage,
  inputAssociationSchema,
  type StreamMessage,
  schemas,
} from "@intrica/contracts";
import { Type } from "typebox";
import { hostCapabilities } from "../adapters/host/executor.js";
import { id } from "../adapters/postgres/database.js";
import type { AppInstance } from "../app.js";
import type { Kernel } from "../composition.js";
import { expediteInput } from "../modules/work/input-receipts.js";
import { retryResourceResponse } from "../modules/work/resource-response.js";
import { conversationTrace } from "../modules/work/trace.js";
import { promptLanguage, promptText } from "../prompt-language.js";
import { createStream } from "./streams.js";

const params = Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) });
const canvasFilter = {
  canvasId: Type.String(),
  selection: Type.Optional(Type.String()),
  groupId: Type.Optional(Type.String()),
};
const messageCursor = Type.Optional(Type.String({ minLength: 1, maxLength: 256 }));
const activityFilter = (query: { selection?: string; groupId?: string }) => ({
  selection: query.selection?.split(",").filter(Boolean).slice(0, 1000),
  groupId: query.groupId,
});
export function registerConversations(app: AppInstance, k: Kernel) {
  app.get("/api/v2/conversations/:id/trace", { schema: { params } }, (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return conversationTrace(k.db, req.params.id);
  });
  app.post(
    "/api/v2/conversations/:id/expedite",
    {
      schema: {
        params,
        body: Type.Object(
          { messageId: Type.String({ minLength: 1, maxLength: 200 }) },
          { additionalProperties: false },
        ),
      },
    },
    (req) => expediteInput(k.db, req.params.id, req.body.messageId),
  );
  app.get("/api/v2/canvas-agents/:id/permissions", { schema: { params } }, (req) =>
    k.access.describe(req.params.id),
  );
  app.get(
    "/api/v2/canvas-agents/:id",
    {
      schema: {
        params,
        querystring: Type.Object({
          before: Type.Optional(Type.Integer({ minimum: 1 })),
          after: Type.Optional(Type.Integer({ minimum: 0 })),
          around: Type.Optional(Type.Integer({ minimum: 1 })),
          requestId: Type.Optional(Type.String()),
        }),
      },
    },
    async (req) => {
      const c = await k.conversations.read.forAgent(req.params.id);
      const feed = await k.conversations.read.feed(req.params.id, req.query);
      return {
        ...feed,
        requests: await k.access.forSubject(
          c.canvas_id,
          req.params.id,
          req.query.requestId,
          feed.events
            .filter((e) => ["access", "permission_notice"].includes(e.kind))
            .map((e) => e.data.requestId),
        ),
      };
    },
  );
  app.get(
    "/api/v2/canvas-agents/:id/events/:seq",
    { schema: { params: Type.Object({ id: Type.String(), seq: Type.Integer({ minimum: 1 }) }) } },
    async (req) => {
      const c = await k.conversations.read.forAgent(req.params.id);
      const r = await k.conversations.read.event(c.id, req.params.seq);
      return {
        conversationId: c.id,
        recordVersion: r.record_version,
        seq: Number(r.seq),
        agentId: req.params.id,
        kind: r.role,
        data: r.content,
        createdAt: new Date(r.created_at).toISOString(),
      };
    },
  );
  app.get("/api/v2/canvas-agents/:id/capabilities", { schema: { params } }, async () =>
    hostCapabilities(),
  );
  app.post(
    "/api/v2/canvas-agents/:id/run",
    {
      schema: {
        params,
        body: Type.Object({
          message: Type.String({ minLength: 1, maxLength: 8000 }),
          association: Type.Optional(inputAssociationSchema),
          resumeRunId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
          idempotencyKey: Type.Optional(Type.String({ maxLength: 200 })),
        }),
      },
    },
    async (req, reply) => {
      const c = await k.conversations.read.forAgent(req.params.id);
      const response = await k.conversations.submit({
        requestId: req.id,
        canvasId: c.canvas_id,
        agentId: req.params.id,
        message: req.body.message,
        association: req.body.association,
        ...(req.body.resumeRunId ? { resumeRunId: req.body.resumeRunId } : {}),
        language: promptLanguage(req.headers["accept-language"]),
        key: req.body.idempotencyKey ?? id("input"),
      });
      return reply
        .code(202)
        .send({ started: true, runId: response.run.id, messageId: response.messageId });
    },
  );
  app.post("/api/v2/canvas-agents/:id/stop", { schema: { params } }, async (req) =>
    k.conversations.stop(req.params.id),
  );
  app.post(
    "/api/v2/canvas-agents/:id/resource-response/retry",
    {
      schema: {
        params,
        body: Type.Object(
          {
            expectedRevision: Type.String({ pattern: "^[1-9][0-9]{0,18}$" }),
            idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    (req) =>
      retryResourceResponse(
        k.db,
        req.params.id,
        req.body.expectedRevision,
        req.body.idempotencyKey,
      ),
  );
  app.post("/api/v2/canvas-agents/:id/reset", { schema: { params } }, async (req) =>
    k.conversations.reset(req.params.id),
  );
  app.post(
    "/api/v2/canvas-agents/batch",
    {
      schema: {
        body: Type.Object({
          agentIds: Type.Array(Type.String(), { minItems: 1, maxItems: 1000 }),
          action: Type.Union([Type.Literal("start"), Type.Literal("stop")]),
          idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
        }),
      },
    },
    async (req) =>
      k.conversations.controlTeams(
        req.body.agentIds,
        req.body.action,
        req.body.idempotencyKey,
        promptLanguage(req.headers["accept-language"]),
      ),
  );
  app.get(
    "/api/v2/canvas-activity",
    {
      schema: {
        querystring: Type.Object({
          ...canvasFilter,
          summary: Type.Optional(Type.Boolean()),
          before: messageCursor,
          after: messageCursor,
          around: messageCursor,
        }),
      },
    },
    async (req) =>
      k.activity.board(req.query.canvasId, req.query.summary, activityFilter(req.query), req.query),
  );
  app.get(
    "/api/v2/canvas-activity/navigation",
    { schema: { querystring: Type.Object({ ...canvasFilter, after: messageCursor }) } },
    (req) => k.activity.navigation(req.query.canvasId, activityFilter(req.query), req.query.after),
  );
  app.get(
    "/api/v2/canvas-activity/navigation/:key",
    {
      schema: {
        params: Type.Object({ key: Type.String({ minLength: 1, maxLength: 256 }) }),
        querystring: Type.Object(canvasFilter),
      },
    },
    (req) => k.activity.preview(req.query.canvasId, activityFilter(req.query), req.params.key),
  );
  app.get(
    "/api/v2/agent-access",
    {
      schema: {
        querystring: Type.Object({
          canvasId: Type.String(),
          subjectId: Type.Optional(Type.String()),
          status: Type.Optional(Type.String()),
          cursor: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        }),
      },
    },
    async (req) => k.access.list(req.query.canvasId, req.query),
  );
  app.post(
    "/api/v2/agent-access/:id",
    {
      schema: {
        params,
        body: Type.Object({
          decision: Type.Union([
            Type.Literal("approve"),
            Type.Literal("deny"),
            Type.Literal("escalate"),
          ]),
          reason: Type.String({ maxLength: 2000 }),
          version: Type.Integer({ minimum: 1 }),
        }),
      },
    },
    async (req) =>
      k.access.decide(req.params.id, req.body.version, req.body.decision, req.body.reason),
  );
  app.post(
    "/api/v2/tool-calls/:id/resolve",
    {
      schema: {
        params,
        body: Type.Object({
          decision: Type.Union([
            Type.Literal("done"),
            Type.Literal("abandon"),
            Type.Literal("retry"),
          ]),
          note: Type.String({ maxLength: 2000 }),
        }),
      },
    },
    async (req) => k.conversations.resolveUnknown(req.params.id, req.body.decision, req.body.note),
  );
  app.get("/api/v2/conversations/:id", { schema: { params } }, async (req) =>
    k.conversations.read.view(req.params.id),
  );
  app.get(
    "/api/v2/conversations/:id/navigation",
    {
      schema: {
        params,
        querystring: Type.Object({ after: Type.Optional(Type.Integer({ minimum: 0 })) }),
      },
    },
    (req) => k.conversations.read.navigation.index(req.params.id, req.query.after ?? 0),
  );
  app.get(
    "/api/v2/conversations/:id/navigation/:seq",
    {
      schema: { params: Type.Object({ id: Type.String(), seq: Type.Integer({ minimum: 1 }) }) },
    },
    (req) => k.conversations.read.navigation.preview(req.params.id, req.params.seq),
  );
  app.get(
    "/api/v2/conversations/:id/messages",
    {
      schema: {
        params,
        querystring: Type.Object({
          before: Type.Optional(Type.String({ pattern: "^[0-9]+$" })),
          around: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
      },
    },
    async (req) => ({
      messages: await k.conversations.read.history(
        req.params.id,
        req.query.before,
        req.query.around,
      ),
    }),
  );
  app.post(
    "/api/v2/agent/context",
    {
      schema: {
        body: Type.Object({
          sessionId: Type.String({ maxLength: 200 }),
          model: Type.Optional(Type.Union([schemas.ModelSelectionSchema, Type.Null()])),
        }),
      },
    },
    async (req) => k.conversations.read.context(req.body.sessionId, req.body.model),
  );
  app.post(
    "/api/v2/agent/steer",
    {
      schema: {
        body: Type.Object({
          sessionId: Type.String({ maxLength: 200 }),
          message: Type.String({ minLength: 1, maxLength: 8000 }),
          association: Type.Optional(inputAssociationSchema),
          idempotencyKey: Type.Optional(Type.String()),
        }),
      },
    },
    async (req) => {
      const submitted = await k.conversations.steer({
        requestId: req.id,
        conversationId: req.body.sessionId,
        message: req.body.message,
        association: req.body.association,
        language: promptLanguage(req.headers["accept-language"]),
        key: req.body.idempotencyKey ?? id("input"),
      });
      return { queued: true, runId: submitted.run.id, messageId: submitted.messageId };
    },
  );
  app.post("/api/v2/runs/:id/cancel", { schema: { params } }, async (req) => {
    await k.runs.cancel(req.params.id);
    return { cancelRequested: true };
  });
  app.post(
    "/api/v2/agent/chat",
    {
      schema: {
        body: Type.Object({
          sessionId: Type.String({ minLength: 1, maxLength: 200 }),
          streamFormat: Type.Optional(Type.Literal("delta")),
          resumeRunId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
          message: Type.String({ minLength: 1, maxLength: 8000 }),
          association: Type.Optional(inputAssociationSchema),
          scopeId: Type.String(),
          selection: Type.Array(Type.String(), { maxItems: 100 }),
          model: Type.Optional(Type.Union([schemas.ModelSelectionSchema, Type.Null()])),
          idempotencyKey: Type.Optional(Type.String()),
        }),
      },
    },
    async (req, reply) => {
      const canvasId = req.body.scopeId
        ? await k.graph.queries.canvasId(req.body.scopeId)
        : (
            await k.graph.createCanvas({
              title: promptText(
                promptLanguage(req.headers["accept-language"]),
                "Workspace",
                "工作区",
              ),
              idempotencyKey: "owner-conversation-canvas",
            })
          ).node.id;
      const submitted = await k.conversations.submit({
        requestId: req.id,
        canvasId,
        conversationId: req.body.sessionId,
        message: req.body.message,
        association: req.body.association,
        ...(req.body.resumeRunId ? { resumeRunId: req.body.resumeRunId } : {}),
        language: promptLanguage(req.headers["accept-language"]),
        key: req.body.idempotencyKey ?? id("input"),
        selection: req.body.selection,
        ...(req.body.model !== undefined ? { model: req.body.model } : {}),
      });
      return createStream(app, reply, async function* (signal) {
        let cursor = "0";
        let message: StreamMessage | undefined;
        yield {
          type: "start",
          runId: submitted.run.id,
          messageId: submitted.messageId,
          mode: submitted.run.frozen_input.model.config.kind,
        };
        while (!signal.aborted) {
          const events = await k.events.read("run", submitted.run.id, cursor);
          for (const event of events) {
            cursor = event.seq;
            if (event.type === "run.finished") {
              yield event.payload.state === "succeeded"
                ? { type: "complete" }
                : { type: "error", message: event.payload.reason ?? "运行已停止" };
              return;
            }
            if (["message", "tool", "context", "compaction", "input.receipt"].includes(event.type))
              if (event.type === "message" && req.body.streamFormat !== "delta") {
                message = applyMessage(message, event.payload);
                yield { ...message, type: "message" };
              } else yield { type: event.type, ...event.payload };
          }
          const run = await k.runs.get(submitted.run.id);
          if (
            ["succeeded", "failed", "cancelled", "waiting"].includes(run.state) &&
            !events.length
          ) {
            yield run.state === "succeeded"
              ? { type: "complete" }
              : { type: "error", message: run.reason ?? "运行已停止" };
            return;
          }
          await delay(250, undefined, { signal });
        }
      });
    },
  );
}
