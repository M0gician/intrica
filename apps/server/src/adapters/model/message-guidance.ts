import type { AgentRole } from "@intrica/contracts";
import { type PromptLanguage, promptText } from "../../prompt-language.js";

export type MessagePromptPolicy = {
  followupLimit: number;
  agentExpediteCooldownSeconds: number;
};

/** Routing applies to both tool messages and final output, including the closing stage. */
export function messageGuidance(
  language: PromptLanguage,
  role: AgentRole | "owner",
  tools: ReadonlySet<string>,
  policy: MessagePromptPolicy,
) {
  const text = (en: string, zh: string) => promptText(language, en, zh);
  const manage = role === "admin" || role === "owner";
  return [
    text(
      "Committed output items form model context. Streaming drafts and interrupted items are diagnostic records. External delivery is confirmed only by a message receipt. Tool updates keep their original task and call identity through input changes. A read input receipt means the input has entered durable model context; task completion and reply delivery have separate receipts. After an input cutover or retry, you continue from committed context and actual tool receipts, applying the current input before the next action.",
      "已提交的完整输出项组成模型上下文。流式草稿与中断项保留为诊断记录。对外投递以消息回执为准。输入变化后，工具更新仍保留原任务和原调用身份。输入已读表示已进入持久模型上下文，任务完成和回复送达分别记录。输入切换或重试后，你从已提交上下文和真实工具回执继续，并在下一步操作前结合当前输入调整工作。",
    ),
    text(
      "Each conversation has one continuous model context. The server selects a current work item and appends eligible input at safe boundaries. Task changes retain earlier context, pending work and delivery receipts. Server request metadata separates incoming obligations from outgoing dependencies and marks truncated indexes. You use the request ID for the task you are answering to choose its recipient. Server coordination notices describe state; user and peer input retain their stated sources.",
      "每个会话使用一份持续的模型上下文。服务端选择当前任务，并在安全边界追加符合条件的输入。任务切换保留已有上下文、待处理工作和投递回执。服务端请求元数据分别列出 incoming 待答复请求和 outgoing 对外依赖，并标明索引截断情况。你根据正在答复的任务选择其请求 ID 和接收者。服务端协作通知说明状态，用户和成员输入保留各自来源。",
    ),
    text(
      `Every authored message declares its target. ${tools.has("send_message") ? "send_message and final text use the same JSON object" : "Final text uses this JSON object"}: {"target":{"kind":"request","id":"the supplied incoming request ID"},"kind":"result","message":"the answer"}. External messages require target, kind and message. A private work note is {"target":{"kind":"internal"},"message":"the note"}; this branch contains only target and message. A final response consists of exactly one JSON object. Final JSON remains available in the reporting stage. A result already sent has a delivery receipt; further private notes use internal. Published file node IDs go in fileIds. Separate messages retain separate purposes and recipients.`,
      `每条主动消息明确声明目标。${tools.has("send_message") ? "send_message 与最终正文使用同一 JSON 对象" : "最终正文使用此 JSON 对象"}：{"target":{"kind":"request","id":"服务端提供的收到的请求 ID"},"kind":"result","message":"答复正文"}。外部消息必填 target、kind 和 message。内部笔记使用 {"target":{"kind":"internal"},"message":"笔记内容"}，此分支只包含 target 和 message。最终答复直接输出一个 JSON 对象，汇报阶段仍可输出最终 JSON。已发送的结果具有投递回执，后续自身记录使用 internal。fileIds 填写已发布文件节点 ID。不同消息保留各自的用途和收件人。`,
    ),
    text(
      'target={kind:"request",id} uses an incoming request ID and routes to its requester; the server follows active task owners after takeover or shared delegation. kind=update leaves the request open. kind=result or kind=decline settles that request after delivery. kind=decline applies only to a request target. kind=request creates a new reply obligation for each recipient; on an incoming request target it asks the requester a question and leaves the original task open. Results sent directly to an Agent are proactive reports. Internal notes and run completion leave open requests pending.',
      'target={kind:"request",id} 使用收到的请求 ID，将消息回复给请求方；接管或共享委托后，服务端按仍在负责该任务的会话路由。kind=update 保持请求开放。kind=result 或 kind=decline 在投递后结束该请求。kind=decline 仅用于 request 目标。kind=request 为每个接收者创建新的待回复请求；目标为收到的请求时，它向请求方提问，并保留原任务。直接发给 Agent 的 result 是主动报告。内部笔记和运行结束保留仍开放的请求。',
    ),
    text(
      `target={kind:"followup",id} uses an outgoing request ID controlled by your conversation and kind=update to add input for its current recipient. Server metadata marks controlsFollowup. The request stays open and keeps its identity. Followups apply to open requests with queued, active or waiting work. The current per-request followup limit is ${policy.followupLimit}, with at most one followup per wait window. Request metadata and wait receipts record followupCount. target={kind:"manager"} selects an existing direct manager; NO_MANAGER indicates a missing manager. Replies to users and workspaces use their incoming request IDs.`,
      `target={kind:"followup",id} 使用由当前会话负责跟进的已发出请求 ID，并以 kind=update 向其当前接收者追加输入。服务端元数据以 controlsFollowup 标明跟进归属。请求继续开放并保留原 ID。跟进适用于仍开放且处于可处理状态的请求。当前每个请求的跟进上限为 ${policy.followupLimit} 次，每个等待窗口最多一次。请求元数据和等待回执以 followupCount 记录已用次数。target={kind:"manager"} 指向现有直属管理者，NO_MANAGER 表示缺少管理者。回复用户和工作区会话使用收到的请求 ID。`,
    ),
    text(
      `The agent target selects one member. ${manage ? "The agents and canvas targets select a specified set and all other canvas members. Your authority permits direct contact with any Agent on this canvas." : "Communication follows your current grants."} The resource_readers target selects readers of every chosen resource. lifetime applies only to kind=request. Its default exclusive lifetime closes a child request when its last active parent ends. A shared child continues for surviving parents. lifetime=independent lets the request continue after its parent ends. A wait on an existing outgoing request retains that dependency for the current task.`,
      `agent 目标选择单个成员。${manage ? "agents 和 canvas 目标分别选择指定集合和画布上的其他所有成员。你的权限允许直接联系本画布任意 Agent。" : "通信范围遵循当前授权。"}resource_readers 目标选择拥有全部所选资源读取权限的成员。lifetime 仅用于 kind=request。默认 exclusive 表示最后一个有效父任务结束时，子请求随之结束。共享子请求继续服务于仍有效的父任务。lifetime=independent 允许请求在父任务结束后继续。等待已有的已发出请求，会为当前任务保留该依赖。`,
    ),
    tools.has("send_message")
      ? text(
          "You actively ask relevant members questions, share findings, compare conflicting evidence and announce dependency changes. Task messages contain the goal, inputs, responsibility, dependencies, deliverables and completion checks. Progress messages contain completed work, evidence, pending items and required help. You respond to relevant peer questions. New information or task changes trigger follow-up communication.",
          "你主动向相关成员提问、共享发现、核对分歧并通知依赖变化。任务消息包含目标、输入、责任范围、依赖、交付物和完成条件。进展消息包含已完成工作、证据、待处理事项和所需协助。你回应相关成员的问题。新的信息或任务变化触发后续沟通。",
        )
      : "",
    tools.has("wait_for_message")
      ? text(
          "You advance independent work while replies are pending. wait_for_message accepts outgoing requestIds for selected dependencies. With requestIds omitted, it waits for external input for the current task, or enters idle waiting when the current task is empty. Any relevant reply or a selected request closing releases the wait once. timeoutSeconds is optional and follows the supplied schema bounds; omission keeps the wait open until input or a state change. A timeout wakes only you with receipts and progress, keeping requests open. You decide whether to wait again, send an allowed followup, or report a blocker. Each wait starts a new window within the same per-request followup budget.",
          "你在等待回复期间推进独立工作。wait_for_message 的 requestIds 指定要等待的已发出请求。省略 requestIds 时，等待当前任务的外部输入；当前任务为空时，进入空闲等待。任一相关回复或所选请求结束会解除本次等待，通知只发送一次。timeoutSeconds 可选，范围以当前参数定义为准；省略时持续等待输入或状态变化。超时仅携带回执及进展唤醒自身，请求保持开放。你选择再次等待、发送允许的 followup，或报告阻塞。每次等待开启新窗口，同时沿用该请求的跟进次数上限。",
        )
      : "",
    manage
      ? text(
          `You use priority=expedite only when input must interrupt the recipient's current model turn. ${role === "owner" ? `The workspace owner can expedite; Agent-initiated expedites have a ${policy.agentExpediteCooldownSeconds}-second recipient cooldown.` : `Agent-initiated expedites require another Agent as recipient and have a ${policy.agentExpediteCooldownSeconds}-second recipient cooldown.`} Started tools retain their original receipts. Stopped runs, tool-contract upgrade pauses and unknown tool outcomes retain their barriers. Normal input waits for a safe context boundary; expedited input enters the same continuous context.`,
          `仅在输入需要打断接收者当前模型执行时使用 priority=expedite。${role === "owner" ? `工作区所有者可加急输入；Agent 发起的加急有按接收者计算的 ${policy.agentExpediteCooldownSeconds} 秒冷却期。` : `Agent 发起的加急以其他 Agent 为接收者，并有按接收者计算的 ${policy.agentExpediteCooldownSeconds} 秒冷却期。`}已开始的工具保留原回执。已停止的运行、工具协议升级暂停和未知工具结果保留各自的阻塞条件。普通输入等待安全的上下文边界，加急输入进入同一份持续上下文。`,
        )
      : "",
    role === "admin"
      ? text(
          "A takeover delivery uses kind=result with handoff.sourceRunIds naming the exact taken-over runs and optional handoff.resourceIds naming the delivered resources.",
          "接管交付使用 kind=result，handoff.sourceRunIds 指定已接管的准确运行 ID，可选 handoff.resourceIds 指定交付资源。",
        )
      : "",
  ];
}
