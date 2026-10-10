import { schemas } from "@intrica/contracts";
import { Type } from "typebox";
import type { AppInstance } from "../app.js";
import type { Kernel } from "../composition.js";
import { promptLanguage } from "../prompt-language.js";

const params = Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) });
export function registerGraph(app: AppInstance, k: Kernel) {
  app.get(
    "/api/v2/bootstrap",
    { schema: { querystring: Type.Object({ canvasId: Type.Optional(Type.String()) }) } },
    async (req) => k.bootstrap(req.query.canvasId),
  );
  app.post(
    "/api/v2/canvases",
    {
      schema: {
        body: Type.Object({
          title: Type.String({ maxLength: 500 }),
          idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
        }),
      },
    },
    async (req) => k.graph.createCanvas(req.body),
  );
  app.delete(
    "/api/v2/canvases/:id",
    { schema: { params, body: schemas.IdempotencyBodySchema } },
    async (req) => k.graph.deleteCanvas(req.params.id, req.body),
  );
  app.patch(
    "/api/v2/canvases/:id",
    {
      schema: {
        params,
        body: Type.Object(
          {
            title: Type.String({ minLength: 1, maxLength: 500 }),
            expectedTitle: Type.String({ maxLength: 500 }),
            idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => k.graph.renameCanvas(req.params.id, req.body),
  );
  app.post("/api/v2/nodes", { schema: { body: schemas.CreateNodeBodySchema } }, async (req) => {
    if (req.body.agent?.schedule)
      req.body.agent.schedule.language = promptLanguage(req.headers["accept-language"]);
    return k.graph.createNode(req.body, undefined, promptLanguage(req.headers["accept-language"]));
  });
  app.post(
    "/api/v2/graph-ops/copy",
    {
      schema: {
        body: Type.Object(
          {
            nodeIds: Type.Array(Type.String(), { minItems: 1, maxItems: 10000, uniqueItems: true }),
            idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => k.graph.copyNodes(req.body),
  );
  app.get("/api/v2/nodes/:id/content", { schema: { params } }, async (req) => ({
    node: await k.graph.queries.node(req.params.id),
  }));
  app.patch(
    "/api/v2/nodes/:id",
    { schema: { params, body: schemas.UpdateNodeBodySchema } },
    async (req) => {
      if (req.body.agent?.schedule)
        req.body.agent.schedule.language = promptLanguage(req.headers["accept-language"]);
      return k.graph.updateNode(req.params.id, req.body);
    },
  );
  app.post(
    "/api/v2/graph-ops",
    { schema: { body: schemas.SubmitGraphOpBodySchema } },
    async (req) =>
      req.body.kind === "move" ? k.graph.submitMove(req.body) : k.graph.deleteNodes(req.body),
  );
  app.post("/api/v2/graph-ops/:id/undo", { schema: { params } }, async (req) =>
    k.graph.undoGraphOp(req.params.id),
  );
  app.post("/api/v2/links", { schema: { body: schemas.CreateLinkBodySchema } }, async (req) =>
    k.graph.createLink(req.body),
  );
  app.post(
    "/api/v2/links/batch",
    {
      schema: {
        body: Type.Object({
          fromIds: Type.Array(Type.String(), { minItems: 1, maxItems: 100 }),
          toId: Type.String(),
          idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
        }),
      },
    },
    async (req) => k.graph.createLinks(req.body),
  );
  app.delete(
    "/api/v2/links/:id",
    { schema: { params, body: schemas.DeleteLinkBodySchema } },
    async (req) => k.graph.deleteLink(req.params.id, req.body),
  );
  app.post(
    "/api/v2/operations/preview",
    { schema: { body: schemas.OperationIntentBodySchema } },
    async (req) => k.generation.preview(req.body),
  );
  app.post(
    "/api/v2/operations",
    { schema: { body: schemas.CreateOperationBodySchema } },
    async (req) =>
      k.generation.create(req.body, undefined, promptLanguage(req.headers["accept-language"])),
  );
  app.get("/api/v2/operations/:id", { schema: { params } }, async (req) => ({
    ...(await k.generation.view(req.params.id)),
    queuePosition: null,
  }));
  app.post(
    "/api/v2/operations/:id/accept",
    {
      schema: {
        params,
        body: Type.Intersect([
          schemas.IdempotencyBodySchema,
          Type.Object({
            candidateIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 20 })),
          }),
        ]),
      },
    },
    async (req) => k.generation.accept(req.params.id, req.body),
  );
  app.post(
    "/api/v2/operations/:id/discard",
    { schema: { params, body: schemas.IdempotencyBodySchema } },
    async (req) => k.generation.discard(req.params.id, req.body),
  );
  app.post(
    "/api/v2/operations/:id/cancel",
    { schema: { params, body: schemas.IdempotencyBodySchema } },
    async (req) => {
      await k.runs.cancel(req.params.id);
      return {
        operation: (await k.generation.view(req.params.id)).operation,
        event: null,
        graphRevision: 0,
      };
    },
  );
  app.post(
    "/api/v2/operations/:id/retry",
    { schema: { params, body: schemas.IdempotencyBodySchema } },
    async (req) => k.generation.retry(req.params.id, req.body.idempotencyKey),
  );
  app.post(
    "/api/v2/operations/:id/candidates/:candidateId/retry",
    {
      schema: {
        params: Type.Object({ id: Type.String(), candidateId: Type.String() }),
        body: schemas.IdempotencyBodySchema,
      },
    },
    async (req) =>
      k.generation.retry(req.params.id, req.body.idempotencyKey, req.params.candidateId),
  );
}
