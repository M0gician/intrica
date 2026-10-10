import { Type } from "typebox";
import { DomainError } from "../../../adapters/postgres/database.js";
import {
  type Delivery,
  deliverCollaboration,
  selectRecipients,
} from "../../access/collaboration.js";
import { agentIdentity, authorize } from "../../access/policy.js";
import { result } from "../../execution/tool-calls.js";
import {
  idParameter,
  messageParameter,
  object,
  preflightOnly,
  type ToolContext,
  tool,
} from "./context.js";

export function collaborationTools({
  registry,
  ctx,
  input,
  actor,
  text,
  capabilities,
}: ToolContext) {
  const send = tool(
    "send_message",
    capabilities.broadcastCanvas
      ? text(
          "Send to an Agent, an explicit agents list, this canvas (excluding yourself), or readers of ALL selected resources. Same-canvas messages and broadcasts need no communication approval. Recipients are frozen for this call; sending grants no resource access and is not task completion.",
          "向单个 Agent、指定 agents 集合、本画布其他 Agent（canvas），或全部所选资源的读者发送消息。同画布消息与广播无需通信审批。接收者按调用固定；发送不授予资源访问权限，也不代表任务完成。",
        )
      : text(
          "Send a collaboration message to one Agent or to other readers of ALL selected resources. The server freezes recipients for this call. Sending does not grant access to results or submit a report.",
          "向单个 Agent，或有权读取全部所选资源的其他 Agent 发送协作消息。服务端为本次调用冻结接收者。发送不授予结果访问权限，也不提交报告。",
        ),
    object({
      target: Type.Union([
        object({ kind: Type.Literal("agent"), agentId: idParameter }),
        object({
          kind: Type.Literal("agents"),
          agentIds: Type.Array(idParameter, { minItems: 1, maxItems: 1000 }),
        }),
        object({ kind: Type.Literal("canvas") }),
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
      targetKind: target.kind,
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
      "Record a report and notify your direct manager. For file delivery, include fileIds returned by create_artifact; the server verifies their published snapshots. resourceIds deliver read access to executors of runs you took over. Report submission does not end a run or certify completion.",
      "记录报告并通知直属管理者。交付文件时将 create_artifact 返回的节点 ID 填入 fileIds，服务端验证发布快照。resourceIds 为已接管运行的原执行者交付读取权限。提交报告不结束运行，也不代表任务已验收。",
    ),
    object({
      message: messageParameter,
      resourceIds: Type.Optional(Type.Array(idParameter, { maxItems: 100, uniqueItems: true })),
      fileIds: Type.Optional(
        Type.Array(idParameter, { minItems: 1, maxItems: 20, uniqueItems: true }),
      ),
    }),
    "graph",
    preflightOnly,
  );
  report.normalize = async (args) => {
    if (actor.kind !== "agent") throw new DomainError("FORBIDDEN", "团队报告需要 Agent 身份");
    const manager = input.agentId
      ? (await agentIdentity(registry.graph.db.pool, input.agentId)).manager_id
      : null;
    return {
      ...args,
      ...(args.fileIds
        ? { resourceIds: [...new Set([...(args.resourceIds ?? []), ...args.fileIds])] }
        : {}),
      recipients: manager ? [manager] : [],
      messageKind: "report",
    };
  };
  report.modelVisible = actor.kind === "agent";
  for (const definition of [send, report])
    definition.prepare = async (tx, callId, _logical, args) => {
      const intent: Delivery = { kind: "collaboration", ...args };
      for (const nodeId of intent.fileIds ?? []) {
        await authorize(tx, actor, ctx.run.canvas_id, nodeId, "read");
        const node = await registry.graph.queries.node(nodeId, tx);
        if (!node.assetId || node.resource?.snapshot?.assetId !== node.assetId)
          throw new DomainError("VALIDATION", "文件交付需要 create_artifact 创建的发布快照");
        await registry.assets.assertAvailable(node.assetId);
      }
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
