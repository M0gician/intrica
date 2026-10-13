import { Type } from "typebox";
import { DomainError } from "../../../adapters/postgres/database.js";
import { visibleTeam } from "../../access/collaboration.js";
import { agentIdentity } from "../../access/policy.js";
import { result, storedToolResult } from "../../execution/tool-calls.js";
import { Activity } from "../activity.js";
import { object, preflightOnly, idParameter as string, type ToolContext, tool } from "./context.js";

export function conversationTools(context: ToolContext) {
  const { registry, ctx, input, actor, text } = context;
  const review = tool(
    "review_inbox",
    text(
      "Review received messages and sent reply requests before waiting. First read the inbox, then reply or track each open request. Submit reviewKey, handledMessageIds and trackRequestIds to receive a reviewToken; use nextAfter for subsequent unreviewed entries.",
      "等待前复核收发信箱。先查看信箱，再回复或跟踪每个未结请求。提交 reviewKey、handledMessageIds 和 trackRequestIds 后获得 reviewToken；沿 nextAfter 查看尚未复核的后续项。",
    ),
    object({
      reviewKey: Type.Optional(string),
      handledMessageIds: Type.Optional(Type.Array(string, { maxItems: 4000, uniqueItems: true })),
      trackRequestIds: Type.Optional(Type.Array(string, { maxItems: 4000, uniqueItems: true })),
      after: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    "read",
    preflightOnly,
  );
  review.parallel = false;
  review.prepare = async (tx, _call, _logical, args) =>
    result(await registry.messages.review(tx, input.conversationId, args));
  const wait = tool(
    "wait_for_message",
    text(
      "Release execution resources only after reviewing the inbox. Obtain reviewToken from review_inbox after answering or tracking all messages, then set confirmed=true. New messages or changed requests invalidate the review.",
      "复核信箱后释放执行资源。回复或跟踪全部消息后，从 review_inbox 获取 reviewToken，再设置 confirmed=true。新消息或请求状态变化会使复核失效。",
    ),
    object({ confirmed: Type.Optional(Type.Boolean()), reviewToken: Type.Optional(string) }),
    "graph",
    preflightOnly,
  );
  wait.prepare = async (tx, _call, _logical, args) =>
    result(
      await registry.messages.confirmWait(
        tx,
        input.conversationId,
        args.confirmed,
        args.reviewToken,
      ),
    );
  const update = tool(
    "update_message",
    text(
      "Follow up your own unanswered request. wait extends its deadline without messaging the recipient; expedite asks the recipient to prioritize the original request; cancel stops tracking. Use requestId from the send receipt or review_inbox.",
      "跟踪自己尚未收到回复的请求。wait 仅延长预期时间；expedite 要求接收者优先处理原请求；cancel 停止跟踪。requestId 来自发送回执或 review_inbox。",
    ),
    object({
      requestId: string,
      action: Type.Union([Type.Literal("wait"), Type.Literal("expedite"), Type.Literal("cancel")]),
      waitSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 604800 })),
      version: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    "graph",
    preflightOnly,
  );
  update.prepare = async (tx, _call, _logical, args) =>
    result(
      await registry.messages.update(
        tx,
        input.conversationId,
        args.requestId,
        args.action,
        args.waitSeconds,
        args.version,
      ),
    );
  return [
    tool(
      "list_agents",
      text(
        "List your current team members and manager without revealing private conversations or granting resource access.",
        "查看当前团队成员和管理者；不读取私有会话或授予资源权限。",
      ),
      object({}),
      "read",
      async () =>
        result({
          agents: await visibleTeam(registry.graph.db.pool, ctx.run.canvas_id, input.agentId),
        }),
    ),
    review,
    wait,
    update,
    tool(
      "get_agent_status",
      text(
        "Inspect up to 40 agents on this canvas without sending messages or waking them. Returns latest run state, wait reason and pending inbox counts, not conversation content. succeeded means a run finished, not that its business goal was verified. Query when needed; do not poll.",
        "只读查看当前画布最多 40 个 Agent 的最近运行状态、等待原因及待处理消息数量；不发送消息、不唤醒对方、不读取会话正文。succeeded 仅表示本轮执行完成，不代表业务目标已验收。按需查询，不要轮询。",
      ),
      Type.Object({
        agentIds: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
          minItems: 1,
          maxItems: 40,
        }),
      }),
      "read",
      async (_call, args) =>
        result({
          agents: await new Activity(registry.graph.db).inspect(ctx.run.canvas_id, args.agentIds),
        }),
    ),
    tool(
      "get_tool_result",
      text(
        "Read a background tool's status or full result in this conversation without re-executing it. Results also arrive automatically; do not poll.",
        "读取本会话后台工具的状态或完整结果；不会重复执行该工具。结果也会自动回传，不要轮询。",
      ),
      Type.Object({ callId: string }),
      "read",
      async (_call, args) => {
        const call = (
          await registry.graph.db.pool.query(
            "select t.id,t.name,t.state,t.result from tool_calls t join runs r on r.id=t.run_id where t.id=$1 and r.subject_id=$2",
            [args.callId, input.conversationId],
          )
        ).rows[0];
        if (!call) throw new DomainError("NOT_FOUND", "此会话中没有该工具调用");
        return storedToolResult(call, Infinity, input.language);
      },
    ),
    tool(
      "read_conversation",
      text(
        "Read your conversation or a direct report's public collaboration history. Follow nextBefore for earlier messages. Receipts: queued awaits input, consumed is persisted in model context, blocked hit the activation limit, closed is no longer pending with no recorded consumption. Consumption does not prove completion.",
        "读取自己的会话，或直属成员的公开协作历史。沿 nextBefore 读取更早记录。回执：queued 待处理；consumed 已写入模型上下文；blocked 达到自动协作上限；closed 不再待处理且无消费记录。消费不代表任务完成。",
      ),
      Type.Object({
        agentId: Type.Optional(string),
        before: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      "read",
      async (_call, args) => {
        const target = args.agentId ?? input.agentId;
        if (!target) {
          const events = await registry.conversations.read.history(
            input.conversationId,
            args.before?.toString(),
          );
          const oldest = events[0]?.seq;
          const hasMore =
            oldest !== undefined &&
            Boolean(
              (
                await registry.graph.db.pool.query(
                  "select 1 from messages where conversation_id=$1 and seq<$2 limit 1",
                  [input.conversationId, oldest],
                )
              ).rowCount,
            );
          return result({
            conversationId: input.conversationId,
            events,
            nextBefore: hasMore ? Number(oldest) : null,
          });
        }
        const identity = await agentIdentity(registry.graph.db.pool, target);
        if (identity.canvas_id !== ctx.run.canvas_id)
          throw new DomainError("FORBIDDEN", "不能读取其他画布的会话");
        if (actor.kind === "agent" && target !== actor.agentId) {
          if (identity.manager_id !== actor.agentId)
            throw new DomainError("FORBIDDEN", "不能读取其他 Agent 的私有会话");
          return result(
            await registry.conversations.read.collaboration.history(
              target,
              actor.agentId,
              args.before,
            ),
          );
        }
        return result(await registry.conversations.read.feed(target, { before: args.before }));
      },
    ),
  ];
}
