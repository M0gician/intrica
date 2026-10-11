import { messageEnvelopeSchema } from "@intrica/contracts";
import { Type } from "typebox";
import { followupLimit } from "../../collaboration/followups.js";
import {
  messageEnvelope,
  messageEnvelopeExample,
  messageEnvelopeIssues,
} from "../../collaboration/message-envelope.js";
import { AGENT_EXPEDITE_COOLDOWN_MS } from "../../collaboration/urgency.js";
import { result } from "../../execution/tool-calls.js";
import { object, preflightOnly, type ToolContext, tool } from "./context.js";

export function collaborationTools({ registry, ctx, input, text, capabilities }: ToolContext) {
  const destinations = [
    "request",
    "followup",
    "agent",
    "resource_readers",
    "manager",
    "internal",
    ...(capabilities.broadcastCanvas ? ["agents", "canvas"] : []),
  ];
  const { handoff: _handoff, ...fields } = messageEnvelopeSchema.properties;
  const send = tool(
    "send_message",
    text(
      'Send a flat message object. Reply: {"to":"request","id":"incoming request ID","kind":"result","message":"answer"}. Contact a member: {"to":"agent","id":"Agent ID","kind":"request","message":"task"}. Private note: {"to":"internal","message":"note"}. to is a string, never a JSON object or encoded JSON. Copy replyTo/followupTo from server metadata. id is required only for request/followup/agent; ids is required only for agents/resource_readers. External messages require kind. Internal notes accept only to and message. Final text uses the same object. File IDs identify published snapshots.'.replace(
        "agents/resource_readers",
        capabilities.broadcastCanvas ? "agents/resource_readers" : "resource_readers",
      ),
      '使用扁平消息对象。回复：{"to":"request","id":"收到的请求 ID","kind":"result","message":"答复"}。联系成员：{"to":"agent","id":"Agent ID","kind":"request","message":"任务"}。内部笔记：{"to":"internal","message":"笔记"}。to 是字符串，不填写对象或编码后的 JSON。复制服务端元数据中的 replyTo/followupTo。request/followup/agent 必填 id；agents/resource_readers 必填 ids。外部消息必填 kind，内部笔记只填写 to 和 message。最终正文使用相同对象。fileIds 指定发布快照。'.replace(
        "agents/resource_readers",
        capabilities.broadcastCanvas ? "agents/resource_readers" : "resource_readers",
      ),
    ),
    object({
      ...fields,
      ...(!capabilities.broadcastCanvas
        ? {
            ids: Type.Optional({
              ...fields.ids,
              description:
                "Required only for resource_readers. Select at most 40 distinct authorized resource IDs.",
            }),
          }
        : {}),
      to: Type.Union(destinations.map((destination) => Type.Literal(destination))),
      ...(!capabilities.manageTeam ? { priority: Type.Optional(Type.Literal("normal")) } : {}),
      ...(capabilities.role === "admin"
        ? { handoff: messageEnvelopeSchema.properties.handoff }
        : {}),
    }),
    "graph",
    preflightOnly,
  );
  send.inputIssues = messageEnvelopeIssues;
  send.inputExample = (args) =>
    messageEnvelopeExample({ to: destinations.includes(args?.to) ? args.to : "request" });
  send.description += text(
    ` kind=request creates a reply obligation. kind=update records progress. result/decline settle an incoming request after delivery; decline requires to=request. to=followup uses an outgoing request ID and kind=update; to=request replies to incoming work. At most ${followupLimit()} followups per request and one per wait window. lifetime applies only to kind=request: independent survives its parent; exclusive closes with its last active parent.`,
    ` kind=request 创建待回复请求，update 记录进展。result/decline 在投递后结束收到的请求；decline 必须使用 to=request。to=followup、kind=update 跟进已发出的请求；to=request 回复收到的任务。每个请求最多跟进 ${followupLimit()} 次，每个等待窗口最多一次。lifetime 仅用于 kind=request：independent 在父任务结束后继续，exclusive 随最后一个有效父任务结束。`,
  );
  if (capabilities.manageTeam)
    send.description += text(
      ` priority=expedite requests immediate model cutover; Agent-initiated expedites have a ${AGENT_EXPEDITE_COOLDOWN_MS / 1000}-second recipient cooldown. Ordinary actionable inbox messages also refresh active inference through the server inbox policy. Started tools retain their receipts.`,
      ` priority=expedite 请求立即切换模型输入，Agent 发起的加急有按接收者计算的 ${AGENT_EXPEDITE_COOLDOWN_MS / 1000} 秒冷却期。普通可处理输入也按服务端收件箱策略更新当前推理。已开始的工具保留回执。`,
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
          workItemId: original ? (original.work_item_id ?? undefined) : input.workItemId,
          origin: "tool",
          toolCallId: callId,
        },
        messageEnvelope(args),
        `tool:${ctx.run.id}:${logicalId}`,
      ),
    );
  };
  return [send];
}
