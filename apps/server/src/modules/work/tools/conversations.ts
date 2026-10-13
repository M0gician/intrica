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
      "Inspect before waiting or finishing: action=inspect returns reviewId and items with allowedActions. Reply first, then inspect again. action=confirm requires reviewId and a decision for every item. background requires a reason; wait keeps the current work open. Follow nextAfter for all items.",
      "等待或结束前使用 action=inspect 检查信箱。返回 reviewId、items 和允许的 action。先回复必要来信再重新检查。action=confirm 必須提供 reviewId 和每项的 decisions；background 需要 reason，wait 表示当前工作仍需等待。沿 nextAfter 读取全部项目。",
    ),
    object(
      {
        action: Type.Union([Type.Literal("inspect"), Type.Literal("confirm")]),
        reviewId: Type.Optional(string),
        decisions: Type.Optional(
          Type.Array(
            object({
              itemId: string,
              action: Type.Union([
                Type.Literal("handled"),
                Type.Literal("wait"),
                Type.Literal("background"),
              ]),
              reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
            }),
            { maxItems: 4000 },
          ),
        ),
        after: Type.Optional(Type.Integer({ minimum: 0 })),
      },
      {
        anyOf: [
          {
            properties: { action: { const: "inspect" } },
            not: { anyOf: [{ required: ["reviewId"] }, { required: ["decisions"] }] },
          },
          {
            properties: { action: { const: "confirm" } },
            required: ["reviewId", "decisions"],
            not: { required: ["after"] },
          },
        ],
      },
    ),
    "read",
    preflightOnly,
  );
  review.parallel = false;
  review.prepare = async (tx, _call, _logical, args) =>
    result(await registry.messages.review(tx, input.conversationId, args));
  const wait = tool(
    "wait_for_message",
    text(
      "Wait for a dependency only after reviewing the inbox. Use confirmed=true and the current reviewToken. completion=ready means deliver and finish; do not wait just to finish. Without a pending dependency, reason must describe an explicitly assigned future monitoring task. New messages or changed requests invalidate the review.",
      "复核信箱后等待工作依赖，使用 confirmed=true 和当前 reviewToken。completion=ready 时提交结果并结束，无需等待。没有待回复依赖时，reason 必须说明明确承担的后续值守任务。新消息或请求状态变化会使复核失效。",
    ),
    object({
      confirmed: Type.Literal(true),
      reviewToken: string,
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
    }),
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
        args.reason,
      ),
    );
  const update = tool(
    "update_message",
    text(
      "Follow up your own unread message or unanswered request. wait postpones reminders; expedite interrupts active model inference so the recipient can prioritize the message (completed tools are preserved); cancel stops tracking without marking the work complete. Check get_agent_status before interrupting a long generation. Use deliveryId from the receipt or review_inbox.",
      "跟踪自己的未读消息或待回复请求。wait 延后提醒；expedite 会中断正在进行的模型生成以优先处理消息，已完成工具结果保留；cancel 停止跟踪，不表示工作完成。中断长时间生成前用 get_agent_status 核查进展。deliveryId 来自回执或 review_inbox。",
    ),
    object({
      deliveryId: string,
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
        args.deliveryId,
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
        "Inspect up to 40 canvas agents without waking them. Returns run state, wait reason, inbox counts, active tools and model phase/start/first/last response timestamps. Response timestamps show transport activity, not semantic progress. succeeded means a run finished, not business acceptance. Query when needed; do not poll.",
        "只读查看当前画布最多 40 个 Agent，不唤醒对方。返回运行状态、等待原因、信箱数量、活动工具，以及模型阶段、开始和首末响应时间。响应时间表示传输活动，不证明任务进展；succeeded 表示运行结束，不代表验收。按需查询，不要轮询。",
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
