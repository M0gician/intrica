import type { ModelSelection } from "@intrica/contracts";
import type { FrozenModel, ModelRegistry } from "../../adapters/model/registry.js";
import {
  canvasEvent,
  type Database,
  DomainError,
  id,
  type Tx,
} from "../../adapters/postgres/database.js";
import { type PromptLanguage, promptLanguage } from "../../prompt-language.js";
import { agentIdentity } from "../access/policy.js";
import { cancelAgents } from "../execution/cancellation.js";
import { appendMessage, collaborationIdentity } from "../execution/messages.js";
import type { RunStore } from "../execution/store.js";
import type { ExecutionContext } from "../execution/worker.js";
import { ConversationReader } from "./conversation-reader.js";
import { executeConversation } from "./conversation-runtime/execute.js";
import { recordDelivery } from "./messaging/deliveries.js";
import { controlTeams } from "./team-controls.js";
import { resolveToolOutcome } from "./tool-outcomes.js";
import type { ToolSet } from "./tools.js";

export type ConversationInput = {
  traceId?: string;
  conversationId: string;
  agentId: string | null;
  model: FrozenModel;
  selection: string[];
  language?: PromptLanguage;
};
export type ToolsFactory = (ctx: ExecutionContext, input: ConversationInput) => Promise<ToolSet>;

export class Conversations {
  readonly read: ConversationReader;
  /** Called inside the transaction that creates the member. The inbox owns admission. */
  async assignNewAgent(tx: Tx, runId: string, agentId: string, task: string) {
    if (!task?.trim()) throw new DomainError("VALIDATION", "招募必须提供首次任务");
    const run = await this.runs.get(runId, tx);
    const sender = (
      await tx.query("select id,agent_id from conversations where id=$1", [run.subject_id])
    ).rows[0];
    const target = await this.read.forAgent(agentId, tx);
    const identity = await collaborationIdentity(tx, run.canvas_id, sender.agent_id, [agentId]);
    const language = await this.language(sender.id, tx);
    const key = `hire-${agentId}`;
    const deliveryId = await recordDelivery(
      tx,
      run,
      sender.agent_id,
      target,
      { messageId: key, inboxId: key },
      { expectReply: true, replyWithinSeconds: 120 },
    );
    await this.append(
      tx,
      sender.id,
      key,
      "message",
      { ...identity, text: task, recipients: [agentId], messageKind: "task", expectReply: true },
      run.id,
    );
    await this.append(tx, target.id, key, "message", {
      ...identity,
      text: task,
      from: sender.agent_id ?? "workspace",
      deliveryId,
      replyTo: { to: "reply", id: deliveryId },
      expectReply: true,
      messageKind: "task",
      language,
      causeId: run.cause_id,
    });
    await canvasEvent(tx, run.canvas_id, "conversation.changed", {
      agentId: sender.agent_id,
      recipients: [agentId],
    });
    return { status: "pending" as const };
  }
  constructor(
    readonly db: Database,
    readonly runs: RunStore,
    readonly models: ModelRegistry,
  ) {
    this.read = new ConversationReader(db, models);
  }
  async language(
    conversationId: string,
    tx: Pick<Tx, "query"> = this.db.pool,
  ): Promise<PromptLanguage> {
    const row = (
      await tx.query(
        "select content->>'language' as language from messages where conversation_id=$1 and content ? 'language' order by seq desc limit 1",
        [conversationId],
      )
    ).rows[0];
    return promptLanguage(row?.language);
  }
  async activeRun(conversationId: string) {
    return (
      await this.db.pool.query(
        "select id from runs where subject_id=$1 and state in ('queued','running','waiting') order by created_at desc limit 1",
        [conversationId],
      )
    ).rows[0]?.id as string | undefined;
  }
  async append(
    tx: Tx,
    conversationId: string,
    key: string,
    role: string,
    content: unknown,
    runId?: string,
  ) {
    return appendMessage(tx, conversationId, key, role, content, runId);
  }

  async steer(input: {
    requestId?: string;
    conversationId: string;
    message: string;
    key: string;
    language: PromptLanguage;
  }) {
    // The run may finish after the UI decides to steer. submit atomically merges
    // into the active run or admits the next one without dropping the input.
    const conversation = (
      await this.db.pool.query(
        "select c.canvas_id,c.model,r.frozen_input from conversations c left join lateral (select frozen_input from runs where subject_id=c.id order by created_at desc,id desc limit 1) r on true where c.id=$1 and c.agent_id is null",
        [input.conversationId],
      )
    ).rows[0];
    if (!conversation) throw new DomainError("NOT_FOUND", "工作区会话不存在");
    return this.submit({
      ...input,
      canvasId: conversation.canvas_id,
      model: conversation.frozen_input?.model?.profileId
        ? { profileId: conversation.frozen_input.model.profileId }
        : conversation.model,
      selection: conversation.frozen_input?.selection ?? [],
    });
  }

  async submit(input: {
    requestId?: string;
    canvasId: string;
    agentId?: string;
    conversationId?: string;
    message: string;
    key: string;
    model?: ModelSelection | null;
    selection?: string[];
    causeId?: string;
    language?: PromptLanguage;
    resumeRunId?: string;
  }) {
    const agent = input.agentId ? await agentIdentity(this.db.pool, input.agentId) : null;
    if (agent && agent.canvas_id !== input.canvasId)
      throw new DomainError("FORBIDDEN", "Agent 不在此画布");
    const savedSelection =
      !agent && input.model === undefined && input.conversationId
        ? (
            await this.db.pool.query(
              "select model from conversations where id=$1 and canvas_id=$2 and agent_id is null",
              [input.conversationId, input.canvasId],
            )
          ).rows[0]?.model
        : undefined;
    const model = await this.models.capture(input.model ?? agent?.config.model ?? savedSelection);
    const conversationId = input.agentId
      ? (await this.read.forAgent(input.agentId)).id
      : (input.conversationId ?? id("conversation"));
    return this.db.canvas(input.canvasId, async (tx) => {
      const existing = (
        await tx.query("select canvas_id,agent_id from conversations where id=$1", [conversationId])
      ).rows[0];
      if (
        existing &&
        (existing.canvas_id !== input.canvasId || existing.agent_id !== (input.agentId ?? null))
      )
        throw new DomainError("FORBIDDEN", "会话不属于此范围");
      await tx.query(
        "insert into conversations(id,canvas_id,model) values($1,$2,$3) on conflict do nothing",
        [conversationId, input.canvasId, JSON.stringify(input.model ?? null)],
      );
      const prior = (
        await tx.query(
          "select run_id from messages where conversation_id=$1 and client_message_id=$2",
          [conversationId, input.key],
        )
      ).rows[0];
      if (prior?.run_id)
        return { conversationId, messageId: input.key, run: await this.runs.get(prior.run_id, tx) };
      if (input.resumeRunId) {
        const barrier = await this.runs.conversationBarrier(conversationId, tx);
        const latest = (
          await tx.query(
            "select id,superseded_by_run_id from runs where subject_id=$1 order by created_at desc,id desc limit 1",
            [conversationId],
          )
        ).rows[0];
        if (latest?.id !== input.resumeRunId && barrier.paused?.id !== input.resumeRunId)
          throw new DomainError("VERSION_CONFLICT", "当前运行已变化，请重新载入");
        if (!barrier.paused && latest.superseded_by_run_id)
          throw new DomainError("INVALID_STATE", "该运行已由管理 Agent 接管，请输入新的任务");
      }
      const seq = await this.append(tx, conversationId, input.key, "user", {
        text: input.message,
        ...(input.requestId ? { traceId: input.requestId } : {}),
        language: input.language ?? "en",
      });
      const run = await this.runs.enqueue(tx, {
        canvasId: input.canvasId,
        subjectId: conversationId,
        userInitiated: input.causeId === undefined,
        ...(input.resumeRunId ? { resumeRunId: input.resumeRunId } : {}),
        kind: "conversation",
        frozen: {
          ...(input.requestId ? { traceId: input.requestId } : {}),
          conversationId,
          agentId: input.agentId ?? null,
          model,
          selection: input.selection ?? [],
          language: input.language ?? "en",
        } satisfies ConversationInput,
        ...(input.causeId ? { causeId: input.causeId } : {}),
      });
      await tx.query("update messages set run_id=$3 where conversation_id=$1 and seq=$2", [
        conversationId,
        seq,
        run.id,
      ]);
      if (input.resumeRunId && input.resumeRunId !== run.id)
        await tx.query("update runs set superseded_by_run_id=$2 where superseded_by_run_id=$1", [
          input.resumeRunId,
          run.id,
        ]);
      await canvasEvent(tx, input.canvasId, "conversation.changed", {
        conversationId,
        agentId: input.agentId ?? null,
        seq,
      });
      return { conversationId, messageId: input.key, run };
    });
  }
  async execute(ctx: ExecutionContext, factory: ToolsFactory) {
    return executeConversation(this, ctx, factory);
  }
  async controlTeams(
    agentIds: string[],
    action: "start" | "stop",
    key: string,
    language: PromptLanguage,
  ) {
    return controlTeams(this, agentIds, action, key, language);
  }
  async stop(agentId: string) {
    const c = await this.read.forAgent(agentId);
    await this.db.canvas(c.canvas_id, (tx) => cancelAgents(tx, [agentId]));
    return { stopped: true };
  }
  async reset(agentId: string) {
    const c = await this.read.forAgent(agentId);
    await this.stop(agentId);
    return this.db.canvas(c.canvas_id, async (tx) => {
      const busy = (
        await tx.query("select 1 from runs where subject_id=$1 and state='running'", [c.id])
      ).rowCount;
      if (busy) throw new DomainError("INVALID_STATE", "运行正在停止，请稍后重置");
      if (
        (
          await tx.query(
            "select 1 from tool_calls t join runs r on r.id=t.run_id where r.subject_id=$1 and t.state='unknown' limit 1",
            [c.id],
          )
        ).rowCount
      )
        throw new DomainError("INVALID_STATE", "请先核实结果未知的工具，再重置会话");
      await tx.query(
        "update conversations set checkpoint='[]',consumed_message_seq=message_seq,context=null where id=$1",
        [c.id],
      );
      await this.append(tx, c.id, id("reset"), "status", {
        text: "会话上下文已重置",
        reason: "reset",
      });
      return { reset: true };
    });
  }
  async resolveUnknown(callId: string, decision: "done" | "abandon" | "retry", note: string) {
    return resolveToolOutcome(this, callId, decision, note);
  }
}
