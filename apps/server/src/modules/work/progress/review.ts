import type { ProgressReviewArgs } from "@intrica/contracts";
import { DomainError, type Tx } from "../../../adapters/postgres/database.js";
import { actionableMessage } from "../../execution/messages.js";
import { progressDeliveries } from "./deliveries.js";
import { wakeDependencies } from "./dependencies.js";
import { progressExecutionState } from "./execution-state.js";
import { mailboxState, resolveMailboxRef } from "./mailbox.js";
import { instructionSources, sourceBoundary } from "./sources.js";

export async function reviewProgress(
  tx: Tx,
  conversationId: string,
  runId: string,
  args: ProgressReviewArgs,
) {
  const fail = (code: string, message: string, details = {}) => {
    throw new DomainError(code, message, details);
  };
  if (!args.reason.trim())
    fail("PROGRESS_REASON_REQUIRED", "Explain the result / 请说明结论", { path: "/reason" });
  if (args.outcome !== "completed" && !args.remaining_work?.trim())
    fail("PROGRESS_WORK_REQUIRED", "Describe unfinished work / 请说明未完成工作", {
      path: "/remaining_work",
    });
  if (args.outcome === "completed" && (args.remaining_work || args.dependency_ids?.length))
    fail(
      "PROGRESS_INCOMPLETE",
      "Use continue, waiting or blocked while work remains / 存在未完成工作时使用 continue、waiting 或 blocked",
    );
  const conversation = (
    await tx.query("select consumed_message_seq from conversations where id=$1 for update", [
      conversationId,
    ])
  ).rows[0];
  if (
    (
      await tx.query(
        `select 1 from messages m where m.conversation_id=$1 and m.seq>$2 and ${actionableMessage} limit 1`,
        [conversationId, conversation.consumed_message_seq],
      )
    ).rowCount
  )
    fail("PROGRESS_NEW_INPUT", "Consume the new input before reviewing / 先处理新输入再复核");
  const execution = await progressExecutionState(tx, runId);
  if (args.outcome === "completed" && execution.pending.length)
    fail(
      "PROGRESS_PENDING_TOOLS",
      "Verify pending tool results before completion / 完成前先核实待完成工具结果",
      { calls: execution.pending },
    );
  const state = await mailboxState(tx, conversationId);
  const dependencies = await Promise.all(
    (args.dependency_ids ?? []).map((ref) => resolveMailboxRef(tx, conversationId, ref)),
  );
  const otherDependencies = (await wakeDependencies(tx, conversationId)).map((d) => d.id);
  if (
    args.outcome === "waiting" &&
    (!dependencies.length ||
      dependencies.some(
        (ref) =>
          !otherDependencies.includes(ref) &&
          !state.items.some((item) => item.id === ref && item.dependency),
      ))
  )
    fail(
      "PROGRESS_DEPENDENCY",
      "Use pending reply IDs from read_inbox; waiting requires a real wake dependency / 使用 read_inbox 中的待回复 ID；等待必须有真实唤醒依赖",
      { path: "/dependency_ids" },
    );
  const required = state.items.filter(
    (item) =>
      args.outcome === "completed" ||
      (args.outcome === "waiting" && item.kind !== "incoming" && !dependencies.includes(item.id)),
  );
  if (required.length)
    fail(
      "PROGRESS_OBLIGATIONS",
      "Handle these obligations before ending or waiting / 结束或等待前处理以下责任",
      { items: required.slice(0, 20), nextAction: "read_inbox({})" },
    );
  const sources = await instructionSources(
    tx,
    conversationId,
    String(conversation.consumed_message_seq),
  );
  const deliveryIds = await progressDeliveries(tx, runId);
  await tx.query(
    `insert into progress_reviews(conversation_id,run_id,outcome,reason,remaining_work,dependency_ids,evidence_refs,delivery_call_ids,input_boundary,instruction_hash,obligations,execution_hash)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict(conversation_id) do update set run_id=excluded.run_id,outcome=excluded.outcome,reason=excluded.reason,
     remaining_work=excluded.remaining_work,dependency_ids=excluded.dependency_ids,evidence_refs=excluded.evidence_refs,
     delivery_call_ids=excluded.delivery_call_ids,input_boundary=excluded.input_boundary,instruction_hash=excluded.instruction_hash,obligations=excluded.obligations,execution_hash=excluded.execution_hash,reviewed_at=now()`,
    [
      conversationId,
      runId,
      args.outcome,
      args.reason,
      args.remaining_work ?? null,
      dependencies,
      args.evidence_refs ?? [],
      deliveryIds,
      state.boundary,
      sourceBoundary(sources),
      JSON.stringify(state.items.map(({ id, revision }) => ({ id, revision }))),
      execution.hash,
    ],
  );
  return {
    outcome: args.outcome,
    reviewed: true,
    ...(args.outcome === "waiting" ? { waitingForMessage: true } : {}),
    remaining_work: args.remaining_work ?? null,
    delivery_call_ids: deliveryIds,
  };
}
