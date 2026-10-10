import { capabilityTools, hostCapabilities } from "../../adapters/host/capabilities.js";
import { EnvironmentRegistry } from "../../adapters/host/environments.js";
import { cleanEnvironment, type HostExecutor } from "../../adapters/host/executor.js";
import { canonicalPath } from "../../adapters/host/sandbox.js";
import { createWebSearchTool } from "../../adapters/host/web-search.js";
import { createWorkspaceTools } from "../../adapters/model/tools.js";
import type { AssetStore } from "../../adapters/storage/assets.js";
import { type AgentCapabilities, agentCapabilities } from "../access/capabilities.js";
import type { AccessService } from "../access/service.js";
import type { ExecutionTool } from "../execution/tool-calls.js";
import type { ExecutionContext } from "../execution/worker.js";
import type { GraphCommands } from "../graph/commands.js";
import { tickSchedules } from "./agent-schedules.js";
import type { ConversationInput, Conversations } from "./conversations.js";
import { canvasTools } from "./tools/canvas.js";
import { collaborationTools } from "./tools/collaboration.js";
import { toolContext } from "./tools/context.js";
import { conversationTools } from "./tools/conversations.js";
import { adaptToolDiscovery } from "./tools/discovery.js";
import { environmentTools } from "./tools/environments.js";
import { permissionTools } from "./tools/permissions.js";
import { readTool } from "./tools/read.js";
import { reviewTools } from "./tools/reviews.js";
import { teamTools } from "./tools/team.js";

export type ToolSet = ExecutionTool[] & { capabilities?: AgentCapabilities };

export class ToolRegistry {
  constructor(
    readonly graph: GraphCommands,
    readonly conversations: Conversations,
    readonly access: AccessService,
    readonly host: HostExecutor,
    readonly assets: AssetStore,
  ) {}

  async describeCapabilities(canvasId: string, agentId: string | null) {
    const [effective, available] = await Promise.all([
      agentCapabilities(this.graph.db, canvasId, agentId),
      hostCapabilities(),
    ]);
    const defaultWorkingDirectory = agentId
      ? (await this.host.scope({ agentId })).cwd
      : (process.env.INTRICA_WORKSPACE_DIR ?? process.cwd());
    return {
      ...available,
      effective: {
        ...effective,
        defaultWorkingDirectory,
        executionMode: effective.hostExecution
          ? "host"
          : available.isolation
            ? "isolated"
            : "unavailable",
      },
      environments: await new EnvironmentRegistry(this.host).list({ canvasId, agentId }),
      environmentMeaning:
        "References share knowledge only. inspect_environment rechecks current access and runtime identity. Unknown runtime versions are null.",
    };
  }

  async create(ctx: ExecutionContext, input: ConversationInput): Promise<ToolSet> {
    const capabilities = await agentCapabilities(this.graph.db, ctx.run.canvas_id, input.agentId);
    const context = toolContext(this, ctx, input, capabilities);
    const { actor, supportsVision } = context;
    const cwd = process.env.INTRICA_WORKSPACE_DIR ?? process.cwd();
    const wrap = (source: any): ExecutionTool => ({
      ...source,
      effect: ["read", "rg", "web_search"].includes(source.name) ? "read" : "external",
      parallel: ["read", "rg", "web_search"].includes(source.name),
      execute: (call, args, signal) => source.execute(call, args, signal),
    });
    const files =
      actor.kind === "agent"
        ? await this.host.tools(actor, input.language, supportsVision)
        : createWorkspaceTools(
            cwd,
            cleanEnvironment(await this.host.workspace(ctx.run.canvas_id)),
            {
              supportsVision,
              ...(process.env.INTRICA_RG_PATH ? { rgExecutable: process.env.INTRICA_RG_PATH } : {}),
            },
          ).map(wrap);
    if (actor.kind === "owner")
      for (const definition of files)
        if (["read", "write", "edit", "rg"].includes(definition.name))
          definition.normalize = async (args) => ({
            ...args,
            path: await canonicalPath(args.path, cwd),
          });
        else if (definition.name === "bash")
          definition.normalize = async (args) => ({
            ...args,
            cwd: await canonicalPath(args.cwd ?? cwd, cwd),
          });
    const tools = [
      ...files,
      ...(actor.kind === "owner" ? capabilityTools(input.language) : []),
      wrap(createWebSearchTool(undefined, input.language)),
      ...canvasTools(context),
      ...collaborationTools(context),
      ...conversationTools(context),
      ...permissionTools(context),
      ...reviewTools(context),
      ...teamTools(context),
    ];
    tools.push(...environmentTools(context, tools));
    const combined = [
      readTool(context, files.find((t) => t.name === "read")!),
      ...tools.filter((t) => t.name !== "read"),
    ];
    for (const definition of combined)
      if (definition.parameters.type === "object")
        definition.parameters = { ...definition.parameters, additionalProperties: false };
    adaptToolDiscovery(combined, context);
    return Object.assign(combined, { capabilities });
  }

  async tickSchedules() {
    return tickSchedules(this);
  }
}
