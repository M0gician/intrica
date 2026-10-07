import { Type } from "typebox";
import { DomainError } from "../../../adapters/postgres/database.js";
import {
  type Delivery,
  deliverCollaboration,
  selectRecipients,
} from "../../access/collaboration.js";
import { agentIdentity } from "../../access/policy.js";
import { result } from "../../execution/tool-calls.js";
import {
  idParameter,
  messageParameter,
  object,
  preflightOnly,
  type ToolContext,
  tool,
} from "./context.js";

export function collaborationTools({ registry, ctx, input, actor, text }: ToolContext) {
  const send = tool(
    "send_message",
    text(
      "Send a collaboration message to one Agent or to other readers of ALL selected resources. The server freezes recipients for this call. Sending does not grant access to results or submit a report.",
      "向单个 Agent，或有权读取全部所选资源的其他 Agent 发送协作消息。服务端为本次调用冻结接收者。发送不授予结果访问权限，也不提交报告。",
    ),
    object({
      target: Type.Union([
        object({ kind: Type.Literal("agent"), agentId: idParameter }),
        object({
          kind: Type.Literal("resource_readers"),
          resourceIds: Type.Array(idParameter, { minItems: 1, maxItems: 40 }),
        }),
      ]),
      message: messageParameter,
    }),
    "graph",
    preflightOnly,
  );
  send.normalize = async (args) => {
    const target =
      args.target.kind === "resource_readers"
        ? { ...args.target, resourceIds: [...new Set<string>(args.target.resourceIds)] }
        : args.target;
    return {
      message: args.message,
      recipients: await selectRecipients(
        registry.graph.db.pool,
        ctx.run.canvas_id,
        input.agentId,
        target,
      ),
      messageKind: args.target.kind === "agent" ? "message" : "broadcast",
      ...(target.kind === "resource_readers" ? { resourceIds: target.resourceIds } : {}),
    };
  };
  const report = tool(
    "report_result",
    text(
      "Record a report and notify your direct manager. Include result resourceIds to deliver read access to executors of runs you took over. Report submission does not end a run or certify task completion.",
      "记录报告并通知直属管理者。resourceIds 为已接管运行的原执行者交付结果读取权限。提交报告不结束运行，也不代表业务任务已验收。",
    ),
    object({
      message: messageParameter,
      resourceIds: Type.Optional(Type.Array(idParameter, { maxItems: 100, uniqueItems: true })),
    }),
    "graph",
    preflightOnly,
  );
  report.normalize = async (args) => {
    if (actor.kind !== "agent") throw new DomainError("FORBIDDEN", "团队报告需要 Agent 身份");
    const manager = input.agentId
      ? (await agentIdentity(registry.graph.db.pool, input.agentId)).manager_id
      : null;
    return { ...args, recipients: manager ? [manager] : [], messageKind: "report" };
  };
  report.modelVisible = actor.kind === "agent";
  for (const definition of [send, report])
    definition.prepare = async (tx, callId, _logical, args) => {
      const intent: Delivery = { kind: "collaboration", ...args };
      if (actor.kind === "agent")
        return registry.access.gate(tx, actor, callId, intent, "Agent communication", true);
      return result(
        await deliverCollaboration(
          tx,
          registry.conversations,
          await registry.conversations.runs.get(ctx.run.id, tx),
          null,
          intent,
          callId,
        ),
      );
    };
  return [send, report];
}
