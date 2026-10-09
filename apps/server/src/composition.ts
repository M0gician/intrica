import { HostExecutor } from "./adapters/host/executor.js";
import { ModelRegistry } from "./adapters/model/registry.js";
import { withModelUsage } from "./adapters/model/usage.js";
import { Database } from "./adapters/postgres/database.js";
import { AssetStore } from "./adapters/storage/assets.js";
import type { ApiConfig } from "./config.js";
import { AccessService } from "./modules/access/service.js";
import { Events } from "./modules/execution/events.js";
import { Statistics } from "./modules/execution/statistics.js";
import { RunStore } from "./modules/execution/store.js";
import { Worker } from "./modules/execution/worker.js";
import { GraphCommands } from "./modules/graph/commands.js";
import { Activity } from "./modules/work/activity.js";
import { Conversations } from "./modules/work/conversations.js";
import { GenerationService } from "./modules/work/generation.js";
import { ToolRegistry } from "./modules/work/tools.js";

export async function createKernel(config: ApiConfig) {
  const db = new Database(config.databaseUrl);
  try {
    await db.migrate(config.schemaFile);
    const graph = new GraphCommands(db),
      runs = new RunStore(db, config.execution),
      models = new ModelRegistry(db, config.dataDir, config.model);
    await runs.settings.initialize();
    await models.initialize();
    const assets = new AssetStore(db, config.dataDir),
      conversations = new Conversations(db, runs, models),
      access = new AccessService(db, graph, conversations, assets);
    const host = new HostExecutor(db, access, config.dataDir);
    const tools = new ToolRegistry(graph, conversations, access, host, assets);
    const generation = new GenerationService(graph, runs, models, (id) => assets.resolve(id));
    const events = new Events(db),
      activity = new Activity(db);
    const statistics = new Statistics(db, runs.settings);
    const measured = (
      ctx: import("./modules/execution/worker.js").ExecutionContext,
      action: () => Promise<void>,
    ) =>
      withModelUsage(
        {
          db,
          purpose: ctx.run.kind,
          model: ctx.run.frozen_input.model,
          runId: ctx.run.id,
          attemptId: ctx.run.attemptId,
          canvasId: ctx.run.canvas_id,
          conversationId: ctx.run.frozen_input.conversationId,
        },
        action,
      );
    let lastMaintenance = 0;
    const worker = new Worker(
      runs,
      {
        generation: (ctx) => measured(ctx, () => generation.execute(ctx)),
        conversation: (ctx) =>
          measured(ctx, () =>
            conversations.execute(ctx, (context, input) => tools.create(context, input)),
          ),
      },
      async () => {
        await access.maintain();
        await tools.tickSchedules();
        if (Date.now() - lastMaintenance > 3600000) {
          lastMaintenance = Date.now();
          await events.prune();
        }
      },
    );
    if (!(await db.pool.query("select 1 from canvases limit 1")).rowCount)
      await graph.createCanvas({ title: "", idempotencyKey: "initial-canvas" });
    const bootstrap = (canvasId?: string) =>
      db.transaction(async (tx) => {
        const snapshot = await graph.queries.snapshot(canvasId, false, tx);
        if (snapshot.activeCanvasId)
          Object.assign(snapshot, await generation.snapshot(snapshot.activeCanvasId, tx));
        return snapshot;
      }, true);
    return {
      config,
      db,
      graph,
      runs,
      models,
      assets,
      access,
      host,
      conversations,
      tools,
      generation,
      events,
      statistics,
      activity,
      worker,
      bootstrap,
    };
  } catch (error) {
    await db.close().catch((cleanupError) => console.error("[database:cleanup]", cleanupError));
    throw error;
  }
}
export type Kernel = Awaited<ReturnType<typeof createKernel>>;
