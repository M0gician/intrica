import { Type } from "typebox";
import { DomainError } from "../../../adapters/postgres/database.js";
import {
  type Delivery,
  deliverCollaboration,
  selectRecipients,
} from "../../access/collaboration.js";
import { agentIdentity, authorize } from "../../access/policy.js";
import { result } from "../../execution/tool-calls.js";
import { replyAddress } from "../message-hooks.js";
import {
  idParameter,
  messageParameter,
  object,
  preflightOnly,
  type ToolContext,
  tool,
} from "./context.js";

export function collaborationTools(context: ToolContext) {
  const { registry, ctx, input, actor, text, capabilities } = context;
  const send = tool(
    "send_message",
    text(
      "Send a message or result using flat fields. to selects agent/id, agents/ids, team, canvas, manager, user, request/id or resource_readers/ids. kind defaults to message; result submits results. expectReply=true creates tracked requests; replyWithinSeconds defaults to 120. Reply using the received replyTo address. Files need published fileIds; sending never grants resource access.",
      "用扁平字段发送消息或结果。to 选择 agent/id、agents/ids、team、canvas、manager、user、request/id 或 resource_readers/ids。kind 默认为 message；result 用于提交结果。expectReply=true 开启回复跟踪；replyWithinSeconds 默认 120 秒。回复时复制来信的 replyTo 地址。文件使用已发布的 fileIds；发送不授予资源权限。",
    ),
    object({
      to: Type.Union(
        ["agent", "agents", "team", "canvas", "manager", "user", "request", "resource_readers"].map(
          (v) => Type.Literal(v),
        ),
      ),
      id: Type.Optional(idParameter),
      ids: Type.Optional(Type.Array(idParameter, { minItems: 1, maxItems: 1000 })),
      kind: Type.Optional(
        Type.Union([Type.Literal("message"), Type.Literal("result"), Type.Literal("reply")]),
      ),
      message: messageParameter,
      expectReply: Type.Optional(Type.Boolean()),
      replyWithinSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 604800 })),
      fileIds: Type.Optional(
        Type.Array(idParameter, { minItems: 1, maxItems: 20, uniqueItems: true }),
      ),
      resourceIds: Type.Optional(Type.Array(idParameter, { maxItems: 100, uniqueItems: true })),
    }),
    "graph",
    preflightOnly,
  );
  send.restore = (args) =>
    args?.target
      ? {
          to: args.target.kind,
          id: args.target.agentId,
          ids: args.target.agentIds ?? args.target.resourceIds,
          message: args.message,
        }
      : args;
  send.normalize = async (args) => {
    const single = ["agent", "request"].includes(args.to),
      multiple = ["agents", "resource_readers"].includes(args.to);
    const invalid = (field: string, message: string): never => {
      throw new DomainError("MESSAGE_INPUT", message, { path: field, executed: false });
    };
    if (single && !args.id) invalid("id", `${args.to} 目标需要 id`);
    if (!single && args.id !== undefined)
      invalid("id", "此目标不接受 id；单个 Agent 使用 to=agent");
    if (multiple && !args.ids?.length) invalid("ids", `${args.to} 目标需要非空 ids`);
    if (!multiple && args.ids !== undefined) invalid("ids", "此目标不接受 ids");
    if (args.replyWithinSeconds !== undefined && args.expectReply !== true)
      invalid("replyWithinSeconds", "设置回复时间时必须 expectReply=true");
    if (args.expectReply && ["request", "user"].includes(args.to))
      invalid("expectReply", "回复及面向用户的结果不建立新的成员回复请求");
    if (args.resourceIds && (!capabilities.manageTeam || args.kind !== "result"))
      invalid("resourceIds", "仅管理者的 result 可交付已接管工作的资源");
    if (args.kind === "reply" && args.to !== "request")
      invalid("to", "kind=reply 需要 to=request，并使用来信 replyTo 中的 id");
    const ids = [...new Set<string>(args.ids ?? [])];
    let recipients: string[] = [],
      targetKind: Delivery["targetKind"];
    let replyTo: string | undefined;
    if (args.to === "request") {
      const request = await replyAddress(registry.graph.db.pool, input.conversationId, args.id);
      recipients = request.sender_agent_id ? [request.sender_agent_id] : [];
      targetKind = recipients.length ? "agent" : "user";
      replyTo = request.id;
    } else if (args.to === "manager") {
      const manager = input.agentId
        ? (await agentIdentity(registry.graph.db.pool, input.agentId)).manager_id
        : null;
      if (!manager) invalid("to", "当前没有直属管理者；向用户交付请使用 to=user");
      recipients = [manager];
      targetKind = "agent";
    } else if (args.to === "user") {
      if (input.agentId && (await agentIdentity(registry.graph.db.pool, input.agentId)).manager_id)
        invalid("to", "成员应向 manager 或 request 回复；直接面向用户需要根 Agent");
      targetKind = "user";
    } else {
      const target =
        args.to === "agent"
          ? { kind: "agent" as const, agentId: args.id }
          : args.to === "agents"
            ? { kind: "agents" as const, agentIds: ids }
            : args.to === "resource_readers"
              ? { kind: "resource_readers" as const, resourceIds: ids }
              : { kind: args.to as "team" | "canvas" };
      recipients = await selectRecipients(
        registry.graph.db.pool,
        ctx.run.canvas_id,
        input.agentId,
        target,
      );
      targetKind = target.kind;
    }
    if (args.expectReply && !recipients.length) invalid("to", "目标没有接收者，无法跟踪回复");
    return {
      message: args.message,
      recipients,
      targetKind,
      messageKind:
        args.kind === "result"
          ? "report"
          : ["agents", "team", "canvas", "resource_readers"].includes(args.to)
            ? "broadcast"
            : "message",
      ...(args.to === "resource_readers"
        ? { resourceIds: ids }
        : args.resourceIds
          ? { resourceIds: args.resourceIds }
          : {}),
      ...(args.fileIds ? { fileIds: args.fileIds } : {}),
      ...(replyTo ? { replyTo } : {}),
      expectReply: args.expectReply ?? false,
      replyWithinSeconds: args.replyWithinSeconds ?? 120,
    };
  };
  send.prepare = async (tx, callId, _logical, args) => {
    const intent: Delivery = { kind: "collaboration", ...args };
    for (const nodeId of intent.fileIds ?? []) {
      await authorize(tx, actor, ctx.run.canvas_id, nodeId, "read");
      const node = await registry.graph.queries.node(nodeId, tx);
      if (
        node.canvasId !== ctx.run.canvas_id ||
        !node.assetId ||
        node.resource?.snapshot?.assetId !== node.assetId
      )
        throw new DomainError("VALIDATION", "fileIds 必须引用当前画布已发布的文件快照", {
          path: "fileIds",
          executed: false,
        });
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
  return [send];
}
