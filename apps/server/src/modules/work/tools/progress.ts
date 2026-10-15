import { Type } from "typebox";
import { DomainError } from "../../../adapters/postgres/database.js";
import { authorize } from "../../access/policy.js";
import { result } from "../../execution/tool-calls.js";
import { disposeMessage, readInbox, resolveMailboxRef } from "../progress/mailbox.js";
import {
  idParameter,
  messageParameter,
  object,
  preflightOnly,
  type ToolContext,
  tool,
} from "./context.js";

export function progressTools(context: ToolContext) {
  const { registry, ctx, input, actor, text } = context;
  const inbox = tool(
    "read_inbox",
    text(
      "Read pending obligations with stable scoped references and pagination. Optional cursor continues a page; receipts that resolve only remove pending items.",
      "分页读取待处理责任及会话内稳定短引用。cursor 继续分页；已解决回执只移除对应待办。",
    ),
    object({ cursor: Type.Optional(idParameter) }),
    "read",
    preflightOnly,
  );
  inbox.prepare = async (tx, _call, _logical, args) =>
    result(await readInbox(tx, input.conversationId, args.cursor));
  const refs = Type.Array(idParameter, { maxItems: 100, uniqueItems: true });
  const review = tool(
    "review_progress",
    text(
      "Review original requirements, delivery and verification before ending or waiting. outcome is completed, continue, waiting or blocked. reason is required; unfinished outcomes require remaining_work. waiting requires dependency_ids and directly waits. Cite actual evidence_refs; an ended run or partial result is not task completion.",
      "结束或等待前对照真实要求、交付和验证。outcome 为 completed、continue、waiting 或 blocked，必须说明 reason；未完成时提供 remaining_work。waiting 需要 dependency_ids，通过后直接等待。evidence_refs 引用真实证据；本轮结束或阶段成果不代表任务完成。",
    ),
    object({
      outcome: Type.Union(
        ["completed", "continue", "waiting", "blocked"].map((v) => Type.Literal(v)),
      ),
      reason: messageParameter,
      remaining_work: Type.Optional(messageParameter),
      dependency_ids: Type.Optional(refs),
      evidence_refs: Type.Optional(refs),
    }),
    "graph",
    preflightOnly,
  );
  review.prepare = async (tx, _call, _logical, args) => {
    const evidence: string[] = args.evidence_refs ?? [];
    const candidates = evidence.length
      ? (
          await tx.query(
            `select t.id,'call' as kind from tool_calls t join runs r on r.id=t.run_id
           where t.id=any($1::text[]) and r.subject_id=$2 and t.state='succeeded'
           union all select id,'node' as kind from nodes where id=any($1::text[]) and canvas_id=$3`,
            [evidence, input.conversationId, ctx.run.canvas_id],
          )
        ).rows
      : [];
    const calls = new Set(candidates.filter((row) => row.kind === "call").map((row) => row.id));
    const nodes = new Set(candidates.filter((row) => row.kind === "node").map((row) => row.id));
    for (const ref of evidence) {
      if (calls.has(ref)) continue;
      if (nodes.has(ref)) {
        await authorize(tx, actor, ctx.run.canvas_id, ref, "read");
        continue;
      }
      throw new DomainError(
        "PROGRESS_EVIDENCE",
        "Cite a succeeded call or accessible canvas artifact / 引用成功调用或可访问的画布产物",
        { path: "/evidence_refs" },
      );
    }
    return result(await registry.messages.review(tx, input.conversationId, ctx.run.id, args));
  };
  const update = tool(
    "update_message",
    text(
      "Handle one message using its delivery_id or scoped inbox ref. wait postpones reminders, background removes a nonessential outgoing dependency with reason, expedite explicitly interrupts the recipient, cancel stops tracking. handled with message_id records disposition of a member-removal notice. reason is required; completed tools are preserved.",
      "用 delivery_id 或信箱短引用处理单条消息：wait 延后提醒，background 说明无需阻塞交付的原因，expedite 显式加急，cancel 停止跟踪。handled 配合 message_id 记录成员移除后的处理结果。必须提供 reason，已完成工具结果保留。",
    ),
    object({
      delivery_id: Type.Optional(idParameter),
      message_id: Type.Optional(idParameter),
      action: Type.Union(
        ["wait", "background", "expedite", "cancel", "handled"].map((v) => Type.Literal(v)),
      ),
      reason: messageParameter,
      wait_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 604800 })),
    }),
    "graph",
    preflightOnly,
  );
  update.prepare = async (tx, _call, _logical, args) => {
    if (
      Number(Boolean(args.delivery_id)) + Number(Boolean(args.message_id)) !== 1 ||
      (args.action === "handled") !== Boolean(args.message_id)
    )
      throw new DomainError(
        "MESSAGE_TARGET",
        "Use delivery_id, or message_id with handled / 使用 delivery_id；处理移除通知时用 message_id 和 handled",
        { path: "/delivery_id" },
      );
    const ref = args.delivery_id ?? args.message_id;
    if (["background", "handled"].includes(args.action))
      return result(await disposeMessage(tx, input.conversationId, ref, args.action, args.reason));
    return result(
      await registry.messages.update(
        tx,
        input.conversationId,
        await resolveMailboxRef(tx, input.conversationId, ref),
        args.action,
        args.wait_seconds,
      ),
    );
  };
  return [inbox, review, update];
}
