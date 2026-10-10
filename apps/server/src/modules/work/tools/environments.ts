import { Type } from "typebox";
import { EnvironmentRegistry } from "../../../adapters/host/environments.js";
import { canonicalPath } from "../../../adapters/host/sandbox.js";
import { DomainError } from "../../../adapters/postgres/database.js";
import { type ExecutionTool, result } from "../../execution/tool-calls.js";
import { object, preflightOnly, type ToolContext, tool } from "./context.js";

export const environmentReference = object({
  id: Type.String({ minLength: 1, maxLength: 200 }),
  version: Type.String({ minLength: 1, maxLength: 200 }),
});

export function environmentTools(context: ToolContext, files: ExecutionTool[]) {
  const { registry, ctx, input, text } = context;
  const environments = new EnvironmentRegistry(registry.host),
    owner = { canvasId: ctx.run.canvas_id, agentId: input.agentId };
  const register = tool(
    "register_environment",
    text(
      "Register an existing interpreter and cwd for reuse on this canvas. instructions records setup/use knowledge, never permissions or executed setup. The version fingerprints the executable identity and cwd identity; package state must still be checked by the task. Registration does not run programs. Share the returned id/version in send_message.environmentRefs. Re-register after a runtime change.",
      "登记已存在的解释器和工作目录以供画布复用。instructions 记录使用知识，不授予权限、不执行安装。版本标识可执行文件与目录的身份；包状态仍需按任务核实。登记不运行程序。通过 send_message.environmentRefs 共享返回的 id/version，运行时变更后重新登记。",
    ),
    object({
      label: Type.String({ minLength: 1, maxLength: 120 }),
      interpreter: Type.String({ minLength: 1, maxLength: 4096 }),
      cwd: Type.String({ minLength: 1, maxLength: 4096 }),
      instructions: Type.String({ minLength: 1, maxLength: 8000 }),
    }),
    "graph",
    preflightOnly,
  );
  register.normalize = async (args) => ({
    ...args,
    interpreter: await canonicalPath(args.interpreter),
    cwd: await canonicalPath(args.cwd),
  });
  register.prepare = async (tx, _call, _logical, args) =>
    result(await environments.register(tx, owner, args));
  const inspect = tool(
    "inspect_environment",
    text(
      "Recheck an environment reference, current access, interpreter identity and cwd before reuse. This does not grant access or run its instructions.",
      "复用前重新检查环境引用、当前权限、解释器身份和工作目录。不授予访问权限，不执行使用说明。",
    ),
    environmentReference,
    "read",
    async (_call, args) => result(await environments.resolve(owner, args)),
  );
  const discover = files.find((t) => t.name === "list_capabilities");
  if (discover)
    discover.execute = async () =>
      result(await registry.describeCapabilities(owner.canvasId, owner.agentId));
  const bash = files.find((t) => t.name === "bash");
  if (bash) {
    const normalize = bash.normalize,
      prepare = bash.prepare,
      execute = bash.execute;
    bash.parameters = object({
      ...bash.parameters.properties,
      environment: Type.Optional(environmentReference),
    });
    bash.description += text(
      " environment={id,version} selects a registered cwd after current permission and runtime checks. Use its interpreter path explicitly in command.",
      " environment={id,version} 在校验当前权限和运行时后选择已登记工作目录。在 command 中明确使用登记的解释器路径。",
    );
    bash.normalize = async (args) => {
      if (!args.environment) return normalize ? normalize(args) : args;
      const environment = await environments.resolve(owner, args.environment);
      if (args.cwd && (await canonicalPath(args.cwd)) !== environment.cwd)
        throw new DomainError("VALIDATION", "cwd 与环境引用不匹配");
      const next = { ...args, cwd: environment.cwd };
      return normalize ? normalize(next) : next;
    };
    bash.prepare = async (tx, call, logical, args) => {
      if (args.environment) await environments.resolve(owner, args.environment, tx);
      return prepare?.(tx, call, logical, args);
    };
    bash.execute = async (call, args, signal) => {
      if (args.environment) await environments.resolve(owner, args.environment);
      return execute(call, args, signal);
    };
  }
  return [register, inspect];
}
