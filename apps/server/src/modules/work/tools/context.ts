import { type TObjectOptions, type TProperties, Type } from "typebox";
import { modelCapabilities } from "../../../adapters/model/model-catalog.js";
import { promptText } from "../../../prompt-language.js";
import type { Actor } from "../../access/policy.js";
import { authorize } from "../../access/policy.js";
import type { ExecutionTool } from "../../execution/tool-calls.js";
import type { ExecutionContext } from "../../execution/worker.js";
import type { ConversationInput } from "../conversations.js";
import type { ToolRegistry } from "../tools.js";

export const idParameter = Type.String({ minLength: 1, maxLength: 200 });
export const messageParameter = Type.String({ minLength: 1, maxLength: 8000 });
export const roleParameter = Type.Union([
  Type.Literal("read"),
  Type.Literal("write"),
  Type.Literal("admin"),
]);
export const object = <T extends TProperties>(properties: T, options: TObjectOptions = {}) =>
  Type.Object(properties, { additionalProperties: false, ...options });

export function tool(
  name: string,
  description: string,
  parameters: any,
  effect: ExecutionTool["effect"],
  execute: ExecutionTool["execute"],
): ExecutionTool {
  return {
    name,
    label: name,
    description,
    parameters,
    effect,
    execute,
    parallel: effect === "read",
  };
}
export const preflightOnly: ExecutionTool["execute"] = async () => {
  throw new Error("This operation must complete inside its durable preflight transaction");
};
export function toolContext(
  registry: ToolRegistry,
  ctx: ExecutionContext,
  input: ConversationInput,
) {
  const actor: Actor = input.agentId
    ? { kind: "agent", agentId: input.agentId, runId: ctx.run.id, epoch: ctx.run.epoch }
    : { kind: "owner", runId: ctx.run.id, epoch: ctx.run.epoch };
  return {
    registry,
    ctx,
    input,
    actor,
    text: (en: string, zh: string) => promptText(input.language, en, zh),
    supportsVision: Boolean(modelCapabilities(input.model.config).supportsVision),
    requireResource: (nodeId: string, mode: "read" | "write") =>
      registry.graph.db.canvas(ctx.run.canvas_id, (tx) =>
        authorize(tx, actor, ctx.run.canvas_id, nodeId, mode),
      ),
  };
}
export type ToolContext = ReturnType<typeof toolContext>;
