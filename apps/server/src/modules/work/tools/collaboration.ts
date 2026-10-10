import {
  externalMessageSchema,
  internalMessageSchema,
  messageKinds,
  messageTargets,
  messageText,
} from "@intrica/contracts";
import { Type } from "typebox";
import { result } from "../../execution/tool-calls.js";
import { object, preflightOnly, type ToolContext, tool } from "./context.js";

export function collaborationTools({ registry, ctx, input, text, capabilities }: ToolContext) {
  const targets = messageTargets.filter(
    (target) =>
      capabilities.broadcastCanvas ||
      !["agents", "canvas"].includes(String(target.properties.kind.const)),
  );
  const send = tool(
    "send_message",
    text(
      "Send an explicitly addressed message or save an internal note. request creates a reply obligation; update records progress; result/decline resolve a request only after delivery. Use target=request and its id to reply. manager selects the direct manager. internal saves only target and message. The same JSON object is the final-output protocol. File IDs identify published snapshots.",
      "发送明确指定目标的消息或保存内部笔记。request 创建待回复请求；update 记录进展；result/decline 在投递后结束关联请求。回复使用 target=request 和请求 id；manager 指向直属管理者；internal 仅填写 target 和 message。最终输出使用同一 JSON 结构。fileIds 指定发布快照。",
    ),
    object({
      target: Type.Union([internalMessageSchema.properties.target, ...targets]),
      kind: Type.Optional(messageKinds),
      message: messageText,
      fileIds: externalMessageSchema.properties.fileIds,
      priority: externalMessageSchema.properties.priority,
      lifetime: externalMessageSchema.properties.lifetime,
      environmentRefs: externalMessageSchema.properties.environmentRefs,
      ...(capabilities.role === "admin"
        ? { handoff: externalMessageSchema.properties.handoff }
        : {}),
    }),
    "graph",
    preflightOnly,
  );
  send.description += text(
    " Use target=followup with the outgoing request id and kind=update to contact its current recipient again; target=request is the recipient reply route. Followups default to one per request and at most one per wait window. lifetime=independent keeps a new request alive after its parent closes; otherwise exclusive ownership applies.",
    " target=followup、kind=update 向已发出请求的当前接收者跟进；target=request 是接收者的回复入口。默认每个请求最多跟进一次，每个等待窗口最多一次。新请求 lifetime=independent 可在父任务结束后继续，否则按专属依赖清理。",
  );
  if (capabilities.manageTeam)
    send.description += text(
      " priority=expedite interrupts a recipient model turn, with a 30-second recipient cooldown.",
      " priority=expedite 打断接收者当前模型执行，接收者有 30 秒冷却期。",
    );
  send.modelParameters = {
    ...send.parameters,
    properties: {
      ...send.parameters.properties,
      ...(!capabilities.manageTeam ? { priority: Type.Optional(Type.Literal("normal")) } : {}),
    },
  };
  const fields: Record<string, any> = {
    ...externalMessageSchema.properties,
    target: Type.Union(targets),
  };
  if (capabilities.role !== "admin") delete fields.handoff;
  send.parameters = Type.Union([internalMessageSchema, object(fields)]);
  send.prepare = async (tx, callId, logicalId, args) => {
    const original = (
      await tx.query("select work_item_id,generation from tool_calls where id=$1", [callId])
    ).rows[0];
    return result(
      await registry.conversations.messaging.sendIn(
        tx,
        {
          run: ctx.run,
          conversationId: input.conversationId,
          agentId: input.agentId,
          generation:
            original?.generation === null ? input.generation : Number(original.generation),
          workItemId: original?.work_item_id ?? input.workItemId,
          origin: "tool",
          toolCallId: callId,
        },
        args,
        `tool:${ctx.run.id}:${logicalId}`,
      ),
    );
  };
  return [send];
}
