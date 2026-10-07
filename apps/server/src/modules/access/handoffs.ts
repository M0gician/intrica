import { canvasEvent, DomainError, type Tx } from "../../adapters/postgres/database.js";
import { promptText } from "../../prompt-language.js";
import { appendMessage } from "../execution/messages.js";
import type { Run } from "../execution/store.js";
import type { ExecutionContext } from "../execution/worker.js";
import type { GraphMutation } from "../graph/mutation.js";
import { agentIdentity, canReadAgentResources, grantsFor } from "./policy.js";
import { coveringGrant } from "./resources.js";

/** Caller holds the canvas lock and the receiving run's fence. */
export async function takeOverRun(tx: Tx, ctx: ExecutionContext, agentId: string, runId: string) {
  const receiver = ctx.run;
  const managerId = receiver.frozen_input.agentId;
  const manager = managerId && (await agentIdentity(tx, managerId));
  const member = await agentIdentity(tx, agentId);
  if (
    manager?.config.role !== "admin" ||
    member.manager_id !== managerId ||
    member.canvas_id !== receiver.canvas_id ||
    !(await canReadAgentResources(tx, managerId, agentId))
  )
    throw new DomainError("FORBIDDEN", "接管需要直属管理权限和成员资源的读取权限");
  const source = (
    await tx.query(
      `select r.* from runs r join conversations c on c.id=r.subject_id
     where c.agent_id=$1 order by r.created_at desc,r.id desc limit 1 for update of r`,
      [agentId],
    )
  ).rows[0] as Run | undefined;
  if (!source || source.id !== runId)
    throw new DomainError("VERSION_CONFLICT", "成员的当前运行已变化，请重新查询");
  if (source.superseded_by_run_id) throw new DomainError("INVALID_STATE", "该运行已被接管");
  const barrier = await ctx.store.conversationBarrier(source.subject_id, tx);
  if (barrier.paused || barrier.unknown)
    throw new DomainError("INVALID_STATE", "此会话需要用户核实结果并明确继续");
  if (
    !(
      source.state === "failed" ||
      source.state === "cancelled" ||
      (source.state === "waiting" && ["message", "turn_limit"].includes(source.reason ?? ""))
    )
  )
    throw new DomainError("INVALID_STATE", "只能接管已停止且工具结果明确的运行");
  if (
    (
      await tx.query(
        "select 1 from tool_calls where run_id=$1 and state not in('succeeded','failed') limit 1",
        [source.id],
      )
    ).rowCount
  )
    throw new DomainError("INVALID_STATE", "请先处理未完成或结果未知的工具");
  await tx.query(
    "update runs set superseded_by_run_id=$2,state='cancelled',cancel_requested_at=now(),reason='handed_off',updated_at=now() where id=$1",
    [source.id, receiver.id],
  );
  const language = receiver.frozen_input.language ?? "en";
  const content = {
    text: promptText(
      language,
      "This run has been taken over by the direct manager. Do not resume its work. New instructions are separate work; read the manager's result before making changes.",
      "该运行已由直属管理 Agent 接管。不要恢复该运行的工作。新的指令作为独立任务处理；修改前先读取管理 Agent 的结果。",
    ),
    language,
    sourceRunId: source.id,
    ownerRunId: receiver.id,
    ownerAgentId: managerId,
    from: managerId,
    to: agentId,
    phase: "taken_over",
  };
  for (const conversationId of [source.subject_id, receiver.subject_id]) {
    await appendMessage(tx, conversationId, `handoff-${source.id}`, "context_notice", content);
    await canvasEvent(tx, receiver.canvas_id, "conversation.changed", { conversationId });
  }
  await canvasEvent(tx, receiver.canvas_id, "run.changed", {
    id: source.id,
    subjectId: source.subject_id,
    kind: source.kind,
    state: "cancelled",
    reason: "handed_off",
  });
  return { sourceRunId: source.id, ownerRunId: receiver.id, ownerAgentId: managerId };
}

/** Final reports and resource grants reach previous executors without restarting their runs. */
export async function publishHandoffReport(
  mutation: GraphMutation,
  run: Run,
  callId: string,
  message: string,
  resourceIds: string[],
) {
  const { tx } = mutation;
  const members = (
    await tx.query(
      `select c.id as conversation_id,c.agent_id,array_agg(r.id order by r.created_at,r.id) as source_run_ids
     from runs r join conversations c on c.id=r.subject_id
     join nodes n on n.id=c.agent_id
     where r.superseded_by_run_id=$1 and n.parent_id=$2 group by c.id,c.agent_id order by c.id`,
      [run.id, run.frozen_input.agentId],
    )
  ).rows;
  const available = await grantsFor(tx, run.frozen_input.agentId);
  for (const resourceId of resourceIds) {
    const resource = await mutation.row(resourceId);
    if (
      resource.kind === "agent" ||
      !(await coveringGrant(
        available,
        { id: resourceId, resource: resource.body.resource },
        "read",
      ))
    )
      throw new DomainError("FORBIDDEN", "只能交付已获读取权限的资源节点");
    for (const member of members) {
      if (
        !(await coveringGrant(
          await grantsFor(tx, member.agent_id),
          { id: resourceId, resource: resource.body.resource },
          "read",
        ))
      ) {
        if ((await agentIdentity(tx, run.frozen_input.agentId)).config.role !== "admin")
          throw new DomainError("FORBIDDEN", "交付资源需要直属管理权限");
        await mutation.connectGrant(
          member.agent_id,
          resourceId,
          "read",
          "user_link",
          undefined,
          run.frozen_input.agentId,
        );
      }
    }
  }
  for (const member of members) {
    await appendMessage(tx, member.conversation_id, `handoff-report-${callId}`, "context_notice", {
      text: message,
      language: run.frozen_input.language ?? "en",
      phase: "reported",
      sourceRunIds: member.source_run_ids,
      ownerRunId: run.id,
      ownerAgentId: run.frozen_input.agentId,
      from: run.frozen_input.agentId,
      to: member.agent_id,
      resourceIds,
    });
    await canvasEvent(tx, run.canvas_id, "conversation.changed", {
      conversationId: member.conversation_id,
    });
  }
  if (members.length && resourceIds.length)
    await mutation.finish("handoff.report", { agentId: run.frozen_input.agentId, runId: run.id });
  return members.map((member) => member.agent_id as string);
}
