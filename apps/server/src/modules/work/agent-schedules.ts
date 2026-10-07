import { CronExpressionParser } from "cron-parser";
import { promptText } from "../../prompt-language.js";
import { agentIdentity } from "../access/policy.js";
import type { ToolRegistry } from "./tools.js";

export async function tickSchedules(registry: Pick<ToolRegistry, "graph" | "conversations">) {
  const schedules = (
    await registry.graph.db.pool.query(
      "select * from schedules where enabled and next_due_at<=clock_timestamp() order by next_due_at limit 20",
    )
  ).rows;
  for (const schedule of schedules) {
    try {
      const identity = await agentIdentity(registry.graph.db.pool, schedule.agent_id);
      if (schedule.kind === "resource_change" && !identity.enabled) {
        await registry.graph.db.pool.query("update schedules set enabled=false where id=$1", [
          schedule.id,
        ]);
        continue;
      }
      const model = await registry.conversations.models.capture(identity.config.model);
      await registry.graph.db.canvas(schedule.canvas_id, async (tx) => {
        const row = (
          await tx.query(
            "select * from schedules where id=$1 and enabled and next_due_at<=clock_timestamp() for update",
            [schedule.id],
          )
        ).rows[0];
        if (!row) return;
        if (row.spec.causeId) {
          const root = (
            await tx.query("select activation_count from runs where id=$1", [row.spec.causeId])
          ).rows[0];
          if (
            !root ||
            root.activation_count >= registry.conversations.runs.limits.collaborationActivations
          ) {
            await tx.query("update schedules set enabled=false where id=$1", [row.id]);
            return;
          }
        }
        const conversation = await registry.conversations.read.forAgent(row.agent_id, tx);
        const language =
          row.spec.language ?? (await registry.conversations.language(conversation.id, tx));
        const key = `schedule-${row.id}-${new Date(row.next_due_at).toISOString()}`;
        await registry.conversations.append(tx, conversation.id, key, "trigger", {
          language,
          text:
            row.kind === "cron"
              ? row.spec.prompt
              : promptText(
                  language,
                  "Authorized resources changed. Review and act according to your role.",
                  "已授权资源发生变化，请根据职责检查并处理。",
                ),
        });
        await registry.conversations.runs.enqueue(tx, {
          canvasId: row.canvas_id,
          subjectId: conversation.id,
          kind: "conversation",
          frozen: {
            conversationId: conversation.id,
            agentId: row.agent_id,
            model,
            selection: [],
            language,
          },
          ...(row.spec.causeId ? { causeId: row.spec.causeId } : {}),
        });
        if (row.kind === "cron")
          await tx.query("update schedules set next_due_at=$2 where id=$1", [
            row.id,
            CronExpressionParser.parse(row.spec.cron, { tz: row.timezone }).next().toDate(),
          ]);
        else await tx.query("update schedules set enabled=false where id=$1", [row.id]);
      });
    } catch (error) {
      console.error("[schedule]", schedule.id, error instanceof Error ? error.message : "failed");
      // A broken model or a full queue must not starve unrelated schedules/runs.
      await registry.graph.db.pool.query(
        "update schedules set next_due_at=now()+interval '1 minute' where id=$1 and next_due_at<=clock_timestamp()",
        [schedule.id],
      );
    }
  }
}
