import { Type } from "typebox";
import { DomainError } from "../../../adapters/postgres/database.js";
import { takeOverRun } from "../../access/handoffs.js";
import { grantsFor } from "../../access/policy.js";
import { result } from "../../execution/tool-calls.js";
import {
  object,
  preflightOnly,
  roleParameter as role,
  idParameter as string,
  type ToolContext,
  tool,
} from "./context.js";
export function teamTools(context: ToolContext) {
  const { registry, ctx, input, actor, text } = context;
  const hire = tool(
    "hire_agent",
    text(
      "Create a member, grant chosen resources, and submit its required first task atomically. Choose inheritResources=true for all current resource grants, or resourceIds for selected nodes (not both); omission grants none. Container access includes nested resources, not Agent private spaces. Delegated access remains bounded by the granting manager. The inbox schedules on-demand members too; do not resend the task. Only users grant admin.",
      "原子创建成员、授予所选资源并提交首次任务 task。inheritResources=true 继承当前全部资源，或 resourceIds 指定节点，二者不能同时设置；省略则不继承。容器覆盖内部资源，不穿过 Agent 私有空间。委托权限持续受授予者权限限制。按需成员也会执行首次任务，不要重复发送。只有用户可授予 admin。",
    ),
    Type.Object({
      title: Type.String({ maxLength: 200 }),
      persona: Type.String({ maxLength: 8000 }),
      task: Type.String({ minLength: 1, maxLength: 8000, pattern: "\\S" }),
      role,
      respondToResources: Type.Boolean(),
      inheritResources: Type.Optional(Type.Boolean()),
      resourceIds: Type.Optional(Type.Array(string, { maxItems: 100, uniqueItems: true })),
    }),
    "graph",
    async (call, args) => {
      return result(
        await registry.graph.command(
          ctx.run.canvas_id,
          `tool-${ctx.run.id}-${call}`,
          "agent.hire",
          args,
          actor,
          async (m) => {
            const nodeId = await m.insert({
              kind: "agent",
              parentId: input.agentId ?? ctx.run.canvas_id,
              title: args.title,
              agent: { persona: args.persona, role: args.role, enabled: args.respondToResources },
              position: await m.agentPosition(input.agentId ?? ctx.run.canvas_id),
            });
            await registry.access.grantRecruitResources(m, input.agentId ?? null, nodeId, args);
            const initialTask = await registry.conversations.assignNewAgent(
              m.tx,
              ctx.run.id,
              nodeId,
              args.task,
            );
            return { id: nodeId, title: args.title, initialTask };
          },
        ),
      );
    },
  );
  hire.normalize = async (args) => {
    if (args.inheritResources && args.resourceIds?.length)
      throw new DomainError("VALIDATION", "请选择继承全部资源或指定节点，不能同时设置");
    if (args.inheritResources && actor.kind !== "agent")
      throw new DomainError("VALIDATION", "工作区招募请指定资源节点");
    const grants =
      actor.kind === "agent"
        ? (await grantsFor(registry.graph.db.pool, actor.agentId)).filter(
            (g) => g.resource_kind !== "agent",
          )
        : [];
    const resourceIds = args.inheritResources
      ? [...new Set(grants.map((g) => g.root_resource_id))]
      : (args.resourceIds ?? []);
    return {
      ...args,
      enabled: args.respondToResources,
      inheritResources: false,
      resourceIds,
      resourceModes: Object.fromEntries(
        resourceIds.map((id: string) => [
          id,
          actor.kind === "owner"
            ? "write"
            : (grants.find((g) => g.resource_id === id)?.mode ?? "read"),
        ]),
      ),
    };
  };
  const configure = tool(
    "configure_agent",
    text(
      "Apply a versioned Agent configuration patch. Omit agentId only to target yourself. An Agent may set its own schedule; other fields require management authority or approval. respondToResources controls only resource changes; schedule.enabled controls cron. Neither stops a run or disables messages.",
      "按版本修改 Agent 配置。仅设置自己时可省略 agentId。Agent 可设置自身计划；其他字段需管理权限或审批。respondToResources 仅控制资源变化响应；schedule.enabled 仅控制定时计划。两者均不停止运行或关闭收件箱。",
    ),
    object({
      agentId: actor.kind === "agent" ? Type.Optional(string) : string,
      expectedRevision: Type.Integer({ minimum: 1 }),
      patch: object(
        {
          persona: Type.Optional(Type.String({ maxLength: 8000 })),
          role: Type.Optional(role),
          respondToResources: Type.Optional(Type.Boolean()),
          schedule: Type.Optional(
            Type.Union([
              Type.Null(),
              object({
                cron: Type.String({ minLength: 1, maxLength: 100 }),
                timezone: Type.String({ minLength: 1, maxLength: 100 }),
                prompt: Type.String({ minLength: 1, maxLength: 8000 }),
                enabled: Type.Boolean(),
              }),
            ]),
          ),
        },
        { minProperties: 1 },
      ),
    }),
    "graph",
    async (call, args) => {
      const node = await registry.graph.queries.node(args.agentId);
      if (!node.agent || node.canvasId !== ctx.run.canvas_id)
        throw new DomainError("NOT_FOUND", "Agent 不存在");
      const agent = { ...node.agent, ...args.patch };
      if (agent.schedule === null) delete agent.schedule;
      return result(
        await registry.graph.updateNode(
          node.id,
          {
            expectedRevision: args.expectedRevision,
            agent,
            idempotencyKey: `tool-${ctx.run.id}-${call}`,
          },
          actor,
        ),
      );
    },
  );
  configure.normalize = async (args) => {
    const { respondToResources, schedule, ...fields } = args.patch;
    return {
      ...args,
      agentId: args.agentId ?? input.agentId,
      patch: {
        ...fields,
        ...(respondToResources !== undefined ? { enabled: respondToResources } : {}),
        ...(schedule !== undefined
          ? {
              schedule:
                schedule === null ? null : { ...schedule, language: input.language ?? "en" },
            }
          : {}),
      },
    };
  };
  const dismiss = tool(
    "dismiss_agent",
    text(
      "Remove a team agent; operations outside your management authority request approval up the management chain, and child resources still require access rights.",
      "移除所属团队 Agent；超出管理权限时沿管理链申请批准，子资源仍须具备访问权限。",
    ),
    Type.Object({ agentId: string }),
    "graph",
    async (call, args) => {
      return result(
        await registry.graph.deleteNodes(
          { nodeIds: [args.agentId], idempotencyKey: `tool-${ctx.run.id}-${call}` },
          actor,
        ),
      );
    },
  );
  const takeover = tool(
    "take_over_run",
    text(
      "Take over a direct report's current stopped run before doing its work. Requires admin and read access to its resources. Resolve unfinished or unknown tool outcomes first. Use the exact runId from get_agent_status.",
      "代做成员工作前，显式接管其当前已停止的运行。需要 admin 和成员资源的读取权限。先处理未完成或结果未知的工具；runId 使用 get_agent_status 的返回值。",
    ),
    object({ agentId: string, runId: string }),
    "graph",
    preflightOnly,
  );
  takeover.modelVisible = actor.kind === "agent";
  takeover.prepare = async (tx, _call, _logical, args) =>
    result(await takeOverRun(tx, ctx, args.agentId, args.runId));
  if (actor.kind === "agent") {
    for (const [definition, operation] of [
      [hire, "hire"],
      [configure, "configure"],
      [dismiss, "dismiss"],
    ] as const)
      definition.prepare = (tx, callId, _logical, args) =>
        registry.access.gate(
          tx,
          actor,
          callId,
          { kind: "agent", operation, args },
          `Agent ${operation}`,
          true,
        );
  }
  return [hire, configure, dismiss, takeover];
}
