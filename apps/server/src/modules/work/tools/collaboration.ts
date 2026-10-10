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
      ...(capabilities.role === "admin"
        ? { handoff: externalMessageSchema.properties.handoff }
        : {}),
    }),
    "graph",
    preflightOnly,
  );
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
