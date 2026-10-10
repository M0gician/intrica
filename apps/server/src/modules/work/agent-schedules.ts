import type { ResourceResponseReason } from "@intrica/contracts";
import { CronExpressionParser } from "cron-parser";
import { DomainError, lockCanvas, type Tx } from "../../adapters/postgres/database.js";
import { promptText } from "../../prompt-language.js";
import { agentIdentity } from "../access/policy.js";
import { cancelResourceSchedules, type Schedule, scheduleChanged } from "../execution/schedules.js";
import type { ToolRegistry } from "./tools.js";

type Registry = Pick<ToolRegistry, "graph" | "conversations">;
const errorReasons: Record<string, keyof typeof blockedText> = {
  MODEL_NOT_CONFIGURED: "model_not_configured",
  LIMIT_REACHED: "activation_limit",
  SOURCE_MISSING: "source_missing",
  QUEUE_FULL: "queue_full",
};
const blockedText = {
  model_not_configured: [
    "Resource response is waiting for model configuration.",
    "资源响应正在等待模型配置。",
  ],
  activation_limit: [
    "Resource response reached the automatic collaboration limit.",
    "资源响应已达到自动协作上限。",
  ],
  source_missing: ["Resource response cannot find its source run.", "资源响应的来源运行已不可用。"],
  queue_full: ["Resource response is waiting for queue capacity.", "资源响应正在等待队列空位。"],
  retry_pending: [
    "Resource response could not start and will retry.",
    "资源响应暂时无法启动，将自动重试。",
  ],
} as const;

async function dispatch(registry: Registry, tx: Tx, row: Schedule) {
  const identity = await agentIdentity(tx, row.agent_id);
  if (row.kind === "resource_change" && !identity.enabled) {
    await cancelResourceSchedules(tx, [row.agent_id], "disabled");
    return;
  }
  if (row.kind === "cron" && !identity.config.schedule?.enabled) {
    await tx.query(
      "update schedules set enabled=false,dispatch_state='cancelled',blocked_reason='disabled',revision=revision+1 where id=$1 and revision=$2",
      [row.id, row.revision],
    );
    await scheduleChanged(tx, [row]);
    return;
  }
  const conversation = await registry.conversations.read.forAgent(row.agent_id, tx);
  const language =
    row.spec.language ?? (await registry.conversations.language(conversation.id, tx));
  await tx.query("savepoint schedule_delivery");
  try {
    const model = await registry.conversations.models.capture(identity.config.model, tx);
    const causeId = row.spec.causeId;
    if (causeId && !(await tx.query("select 1 from runs where id=$1", [causeId])).rowCount)
      throw new DomainError("SOURCE_MISSING", "Resource response source run is unavailable");
    const source = row.spec.sourceSeq ?? "legacy";
    const key =
      row.kind === "cron"
        ? `schedule-${row.id}-${row.next_due_at.toISOString()}`
        : `schedule-${row.id}-${source}`;
    const seq = await registry.conversations.append(tx, conversation.id, key, "trigger", {
      language,
      text:
        row.kind === "cron"
          ? row.spec.prompt
          : promptText(
              language,
              "Authorized resources changed. Review and act according to your role.",
              "已授权资源发生变化，请根据职责检查并处理。",
            ),
      ...(row.kind === "resource_change"
        ? { resourceResponse: { scheduleId: row.id, sourceSeq: source, causeId: causeId ?? null } }
        : {}),
    });
    const run = await registry.conversations.runs.enqueue(tx, {
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
      ...(causeId ? { causeId } : {}),
    });
    await tx.query("update messages set run_id=$3 where conversation_id=$1 and seq=$2", [
      conversation.id,
      seq,
      run.id,
    ]);
    await tx.query(
      `update schedules set enabled=$3,dispatch_state=$4,blocked_reason=null,revision=revision+1,
         delivery_seq=$5,delivery_run_id=$6,next_due_at=$7 where id=$1 and revision=$2`,
      [
        row.id,
        row.revision,
        row.kind === "cron",
        row.kind === "cron" ? "pending" : "delivered",
        seq,
        run.id,
        row.kind === "cron"
          ? CronExpressionParser.parse(row.spec.cron, { tz: row.timezone }).next().toDate()
          : row.next_due_at,
      ],
    );
    await scheduleChanged(tx, [row]);
  } catch (error) {
    // A failed activation must not leave an actionable trigger in the inbox.
    await tx.query("rollback to savepoint schedule_delivery");
    const reason =
      error instanceof DomainError
        ? (errorReasons[error.code] ?? "retry_pending")
        : "retry_pending";
    const automaticRetry = reason === "queue_full" || reason === "retry_pending";
    await tx.query(
      `update schedules set enabled=$3,dispatch_state='blocked',blocked_reason=$4,revision=revision+1,
       next_due_at=case when $3 then clock_timestamp()+interval '1 minute' else next_due_at end
       where id=$1 and revision=$2`,
      [row.id, row.revision, automaticRetry, reason],
    );
    if (row.kind === "resource_change") {
      const [en, zh] = blockedText[reason];
      // Retain the source and reason even after another resource change supersedes this row.
      await registry.conversations.append(
        tx,
        conversation.id,
        `resource-blocked-${row.id}-${row.spec.sourceSeq ?? "legacy"}-${reason}`,
        "run_status",
        {
          category: "resource_response",
          reason: reason satisfies ResourceResponseReason,
          text: promptText(language, en, zh),
          scheduleId: row.id,
          sourceSeq: row.spec.sourceSeq ?? null,
          causeId: row.spec.causeId ?? null,
        },
      );
    }
    if (reason === "retry_pending")
      console.error("[schedule]", row.id, error instanceof Error ? error.message : "failed");
    await scheduleChanged(tx, [row]);
  }
  await tx.query("release savepoint schedule_delivery");
}

export async function tickSchedules(registry: Registry) {
  const schedules = (
    await registry.graph.db.pool.query<Schedule>(
      `select s.* from schedules s join canvases c on c.id=s.canvas_id
       where c.deleted_at is null and s.enabled and s.next_due_at<=clock_timestamp()
       order by s.next_due_at,s.id limit 20`,
    )
  ).rows;
  for (const snapshot of schedules) {
    try {
      await registry.graph.db.transaction(async (tx) => {
        // Same order as global model edits: model lock, canvas, schedule.
        await tx.query(
          "select pg_advisory_xact_lock_shared(hashtextextended('intrica-model-profiles',0))",
        );
        await lockCanvas(tx, snapshot.canvas_id);
        const row = (
          await tx.query<Schedule>(
            "select * from schedules where id=$1 and revision=$2 and enabled and next_due_at<=clock_timestamp() for update",
            [snapshot.id, snapshot.revision],
          )
        ).rows[0];
        if (row) await dispatch(registry, tx, row);
      });
    } catch (error) {
      // Rollback keeps the current schedule intact. Never write a stale failure by ID.
      if (!(error instanceof DomainError && error.code === "NOT_FOUND"))
        console.error("[schedule]", snapshot.id, error instanceof Error ? error.message : "failed");
    }
  }
}
