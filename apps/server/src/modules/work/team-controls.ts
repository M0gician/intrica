import { canvasEvent, DomainError, digest, id } from "../../adapters/postgres/database.js";
import { type PromptLanguage, promptText } from "../../prompt-language.js";
import { agentIdentity } from "../access/policy.js";
import { associateUserInput } from "../collaboration/requests.js";
import { cancelAgents } from "../execution/cancellation.js";
import type { Conversations } from "./conversations.js";

export async function controlTeams(
  conversations: Conversations,
  agentIds: string[],
  action: "start" | "stop",
  key: string,
  language: PromptLanguage,
) {
  const roots = [...new Set(agentIds)].sort();
  if (!roots.length) throw new DomainError("VALIDATION", "请选择 Agent");
  const canvasId = (await agentIdentity(conversations.db.pool, roots[0]!)).canvas_id;
  return conversations.db.canvas(canvasId, async (tx) => {
    const hash = digest({ roots, action });
    const prior = (
      await tx.query(
        "select * from commands where canvas_id=$1 and actor_id='owner' and command_key=$2",
        [canvasId, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== hash)
        throw new DomainError("IDEMPOTENCY_CONFLICT", "请求键已用于不同操作");
      return prior.response;
    }
    const selected = (
      await tx.query(
        "select id from nodes where id=any($1::text[]) and canvas_id=$2 and kind='agent'",
        [roots, canvasId],
      )
    ).rows;
    if (selected.length !== roots.length)
      throw new DomainError("VALIDATION", "所选 Agent 必须位于同一画布");
    const members = (
      await tx.query(
        `with recursive team as (
        select id from nodes where id=any($1::text[]) and canvas_id=$2
        union select n.id from nodes n join team t on n.parent_id=t.id where n.kind='agent' and n.canvas_id=$2
      ) select t.id,c.id as conversation_id,a.config from team t join agent_configs a on a.node_id=t.id join conversations c on c.agent_id=t.id order by t.id`,
        [roots, canvasId],
      )
    ).rows;
    const changed: string[] = [];
    for (const member of members) {
      const active = (
        await tx.query(
          "select state,reason,cancel_requested_at from runs where subject_id=$1 and state in('queued','running','waiting')",
          [member.conversation_id],
        )
      ).rows[0];
      if (action === "stop") {
        if (active && !active.cancel_requested_at) changed.push(member.id);
        continue;
      }
      const latest = (
        await tx.query(
          "select superseded_by_run_id from runs where subject_id=$1 order by created_at desc,id desc limit 1",
          [member.conversation_id],
        )
      ).rows[0];
      if (latest?.superseded_by_run_id) continue;
      if (
        active &&
        (active.state !== "waiting" ||
          !["message", "turn_limit", "reply_required", "message_protocol"].includes(
            active.reason,
          ) ||
          active.cancel_requested_at)
      )
        continue;
      const model = await conversations.models.capture(member.config.model);
      const seq = await conversations.append(tx, member.conversation_id, `batch-${key}`, "user", {
        text: promptText(
          language,
          "Review authorized resources and complete the current work according to your role.",
          "请根据职责检查已授权资源并完成当前工作。",
        ),
        language,
      });
      const associated = await associateUserInput(tx, {
        canvasId,
        conversationId: member.conversation_id,
        agentId: member.id,
        messageId: `batch-${key}`,
        seq,
      });
      const run = await conversations.runs.enqueue(tx, {
        canvasId,
        subjectId: member.conversation_id,
        userInitiated: true,
        kind: "conversation",
        frozen: {
          conversationId: member.conversation_id,
          workItemId: associated.workItemId,
          agentId: member.id,
          selection: [],
          model,
          language,
        },
      });
      await tx.query("update message_requests set cause_id=coalesce(cause_id,$2) where id=$1", [
        associated.workItemId,
        run.cause_id,
      ]);
      await tx.query("update messages set run_id=$3 where conversation_id=$1 and seq=$2", [
        member.conversation_id,
        seq,
        run.id,
      ]);
      if (run.state === "queued" || run.state === "running") changed.push(member.id);
    }
    if (action === "stop")
      await cancelAgents(
        tx,
        members.map((m) => m.id),
      );
    const response = { agentIds: changed, count: changed.length, total: members.length, action };
    await tx.query(
      "insert into commands(id,canvas_id,actor_id,command_key,request_hash,response,kind) values($1,$2,'owner',$3,$4,$5,'agent.control')",
      [id("command"), canvasId, key, hash, JSON.stringify(response)],
    );
    await canvasEvent(tx, canvasId, "conversation.changed", { agentIds: changed });
    return response;
  });
}
