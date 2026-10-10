import { hostname, platform } from "node:os";
import { ExecutionPolicySchema } from "@intrica/contracts";
import { Type } from "typebox";
import { isolationAvailable } from "../adapters/host/sandbox.js";
import {
  diagnosticPolicy,
  pruneModelDiagnostics,
  saveDiagnosticPolicy,
} from "../adapters/model/diagnostic-policy.js";
import type { AppInstance } from "../app.js";
import type { Kernel } from "../composition.js";
export function registerSettings(app: AppInstance, k: Kernel) {
  app.addHook("onRequest", async (req, reply) => {
    if (/^\/api\/v2\/(settings|statistics)\//.test(req.url))
      reply.header("Cache-Control", "no-store");
  });
  app.get("/api/v2/settings/execution", () => k.runs.settings.read());
  app.get("/api/v2/settings/model-diagnostics", () => diagnosticPolicy(k.db));
  app.put(
    "/api/v2/settings/model-diagnostics",
    {
      schema: {
        body: Type.Object(
          {
            expectedRevision: Type.Integer({ minimum: 1 }),
            enabled: Type.Boolean(),
            retentionDays: Type.Integer({ minimum: 1, maximum: 90 }),
            manifestDays: Type.Integer({ minimum: 1, maximum: 365 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    (req) => saveDiagnosticPolicy(k.db, req.body),
  );
  app.delete("/api/v2/settings/model-diagnostics/content", async () => {
    await pruneModelDiagnostics(k.db, true);
    return { cleared: true };
  });
  app.get("/api/v2/settings/diagnostics", async () => {
    const [isolation, summary] = await Promise.all([
      isolationAvailable(),
      k.statistics.liveSummary(),
    ]);
    return {
      hostname: hostname(),
      platform: platform(),
      isolation,
      sandboxStatus:
        process.env.INTRICA_SANDBOX === "disabled"
          ? "disabled"
          : isolation
            ? "enabled"
            : "unavailable",
      checkedAt: new Date().toISOString(),
      ...summary,
    };
  });
  app.put(
    "/api/v2/settings/execution",
    {
      schema: {
        body: Type.Object(
          { expectedRevision: Type.Integer({ minimum: 1 }), policy: ExecutionPolicySchema },
          { additionalProperties: false },
        ),
      },
    },
    (req) => k.runs.settings.save(req.body.expectedRevision, req.body.policy),
  );
  app.get("/api/v2/statistics/overview", () => k.statistics.overview());
  app.get(
    "/api/v2/statistics/usage",
    {
      schema: {
        querystring: Type.Object(
          {
            from: Type.String({ maxLength: 40 }),
            to: Type.String({ maxLength: 40 }),
            canvasId: Type.Optional(Type.String({ maxLength: 200 })),
            groupBy: Type.Optional(
              Type.Union([
                Type.Literal("model"),
                Type.Literal("endpoint"),
                Type.Literal("purpose"),
              ]),
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    (req) => k.statistics.usage(req.query),
  );
}
