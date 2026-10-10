import {
  externalMessageSchema,
  internalMessageSchema,
  messageKinds,
  messageTargets,
  messageText,
} from "@intrica/contracts";
import { Type } from "typebox";
import { followupLimit } from "../../collaboration/followups.js";
import { AGENT_EXPEDITE_COOLDOWN_MS } from "../../collaboration/urgency.js";
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
    ` Use target=followup with the outgoing request id and kind=update to contact its current recipient again; target=request is the recipient reply route. The current followup limit is ${followupLimit()} per request and at most one per wait window. lifetime applies only to kind=request: independent keeps it alive after its parent closes; the default exclusive request closes when its last active parent ends.`,
    ` target=followup、kind=update 向已发出请求的当前接收者跟进；target=request 是接收者的回复入口。当前每个请求最多跟进 ${followupLimit()} 次，每个等待窗口最多一次。lifetime 仅用于 kind=request：independent 在父任务结束后继续，默认 exclusive 在最后一个有效父任务结束时关闭。`,
  );
  if (capabilities.manageTeam)
    send.description += text(
      ` priority=expedite interrupts a recipient model turn. Agent-initiated expedites require another Agent recipient and have a ${AGENT_EXPEDITE_COOLDOWN_MS / 1000}-second recipient cooldown. Workspace owners are exempt from that cooldown. Started tools retain their receipts.`,
      ` priority=expedite 打断接收者当前模型执行。Agent 发起的加急以其他 Agent 为接收者，并有 ${AGENT_EXPEDITE_COOLDOWN_MS / 1000} 秒接收者冷却期。工作区所有者不受该冷却期约束。已开始的工具保留回执。`,
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
          workItemId: original ? (original.work_item_id ?? undefined) : input.workItemId,
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
