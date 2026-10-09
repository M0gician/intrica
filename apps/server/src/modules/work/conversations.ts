import type { ToolCall } from "@earendil-works/pi-ai";
import type { ModelSelection } from "@intrica/contracts";
import { createCanvasAgent } from "../../adapters/model/agent.js";
import { contextUsage, summarizeContext } from "../../adapters/model/context.js";
import { buildConversationPrompt } from "../../adapters/model/prompt.js";
import type { FrozenModel, ModelRegistry } from "../../adapters/model/registry.js";
import {
  assertFence,
  canvasEvent,
  type Database,
  DomainError,
  id,
  type Tx,
} from "../../adapters/postgres/database.js";
import { type PromptLanguage, promptLanguage, promptText } from "../../prompt-language.js";
import { agentIdentity } from "../access/policy.js";
import { BackgroundTools } from "../execution/background-tools.js";
import { cancelAgents } from "../execution/cancellation.js";
import { actionableMessage, appendMessage, collaborationIdentity } from "../execution/messages.js";
import type { RunStore } from "../execution/store.js";
import {
  type ExecutionTool,
  storedToolResult,
  type ToolExecution,
} from "../execution/tool-calls.js";
import type { ExecutionContext } from "../execution/worker.js";
import { ConversationReader } from "./conversation-reader.js";
import { controlTeams } from "./team-controls.js";
import { resolveToolOutcome } from "./tool-outcomes.js";

export type ConversationInput = {
  conversationId: string;
  agentId: string | null;
  model: FrozenModel;
  selection: string[];
  language?: PromptLanguage;
};
export type ToolsFactory = (
  ctx: ExecutionContext,
  input: ConversationInput,
) => Promise<ExecutionTool[]>;

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
    await this.append(
      tx,
      sender.id,
      key,
      "message",
      { ...identity, text: task, recipients: [agentId], messageKind: "task" },
      run.id,
    );
    await this.append(tx, target.id, key, "message", {
      ...identity,
      text: task,
      from: sender.agent_id ?? "workspace",
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
        language: input.language ?? "en",
      });
      const run = await this.runs.enqueue(tx, {
        canvasId: input.canvasId,
        subjectId: conversationId,
        userInitiated: input.causeId === undefined,
        ...(input.resumeRunId ? { resumeRunId: input.resumeRunId } : {}),
        kind: "conversation",
        frozen: {
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
    const input = ctx.run.frozen_input as ConversationInput;
    const config = await this.models.materialize(input.model);
    const model = createCanvasAgent(config, ctx.run.id);
    const conversation = (
      await this.db.pool.query("select * from conversations where id=$1", [input.conversationId])
    ).rows[0];
    if (!conversation) throw new DomainError("NOT_FOUND", "会话已删除");
    model.state.messages = conversation.checkpoint;
    const identity = input.agentId ? await agentIdentity(this.db.pool, input.agentId) : null;
    const savedLanguage = (
      await this.db.pool.query(
        "select content->>'language' as language from messages where conversation_id=$1 and seq<=$2 and content ? 'language' order by seq desc limit 1",
        [input.conversationId, conversation.consumed_message_seq],
      )
    ).rows[0]?.language;
    input.language = promptLanguage(savedLanguage ?? input.language);
    const tools = await factory(ctx, input);
    const modelTools = (definitions: ExecutionTool[]) =>
      definitions
        .filter((t) => t.modelVisible !== false)
        .map((t) => ({
          ...t,
          execute: async () => {
            throw new Error("Tools must use the durable executor");
          },
        }));
    model.state.tools = modelTools(tools);
    const refreshTools = async () => {
      tools.splice(0, tools.length, ...(await factory(ctx, input)));
      return modelTools(tools);
    };
    const setPrompt = () => {
      model.state.systemPrompt = buildConversationPrompt(input.language ?? "en", {
        agent: Boolean(identity),
        persona: identity?.config.persona,
        selection: input.selection,
        asyncSeconds: ctx.store.limits.toolAsyncAfterMs / 1000,
      });
    };
    setPrompt();
    let consumed = String(conversation.consumed_message_seq);
    const consumedInContext = new Set<string>();
    let compactions = conversation.context?.compactions ?? 0;
    let pendingTurnId = conversation.context?.pendingTurnId ?? id("turn");
    let budget = Number(conversation.context?.turnsSinceInput ?? 0);
    let exhausted = conversation.context?.turnLimitReached === true;
    const persist = async (tx: Tx) => {
      const received = await tx.query(
        "update messages set consumed_run_id=$3,consumed_at=now() where conversation_id=$1 and seq=any($2::bigint[]) and consumed_run_id is null returning client_message_id",
        [input.conversationId, [...consumedInContext], ctx.run.id],
      );
      if (received.rowCount) {
        const messageIds = received.rows.map((m) => m.client_message_id);
        await ctx.store.eventTx(tx, ctx.run.id, ctx.run.attemptId, "input.receipt", {
          conversationId: input.conversationId,
          messageIds,
          state: "read",
        });
        await canvasEvent(tx, ctx.run.canvas_id, "conversation.changed", {
          conversationId: input.conversationId,
          agentId: input.agentId,
          consumedMessageIds: messageIds,
        });
      }
      consumedInContext.clear();
      const info = {
        ...contextUsage(model, config),
        compactions,
        pendingTurnId,
        turnsSinceInput: budget,
        turnLimitReached: exhausted,
      };
      await tx.query(
        "update conversations set checkpoint=$2,consumed_message_seq=$3,context=$4 where id=$1",
        [
          input.conversationId,
          JSON.stringify(model.state.messages),
          consumed,
          JSON.stringify(info),
        ],
      );
    };
    const checkpoint = () =>
      this.db.canvas(ctx.run.canvas_id, async (tx) => {
        await assertFence(tx, ctx.run.id, ctx.run.epoch);
        await persist(tx);
      });
    const hasUnread = async (tx: Pick<Tx, "query">) =>
      Boolean(
        (
          await tx.query(
            `select 1 from messages m where m.conversation_id=$1 and m.seq>$2 and ${actionableMessage} limit 1`,
            [input.conversationId, consumed],
          )
        ).rowCount,
      );
    const expedited = async () =>
      Boolean(
        (
          await this.db.pool.query(
            "select 1 from messages where conversation_id=$1 and seq>$2 and consumed_run_id is null and expedite_run_id=$3 limit 1",
            [input.conversationId, consumed, ctx.run.id],
          )
        ).rowCount,
      );
    const logTool = async (tx: Tx, event: Record<string, unknown>) => {
      const key = `tool-${ctx.run.id}-${event.id}`;
      await this.append(tx, input.conversationId, key, "tool", event, ctx.run.id);
      await tx.query(
        "update messages set content=$3 where conversation_id=$1 and client_message_id=$2",
        [input.conversationId, key, JSON.stringify(event)],
      );
      await canvasEvent(tx, ctx.run.canvas_id, "conversation.changed", {
        conversationId: input.conversationId,
        agentId: input.agentId,
      });
    };
    const background = new BackgroundTools(ctx, tools, logTool, async (tx, key, content) => {
      await this.append(tx, input.conversationId, key, "tool_update", content, ctx.run.id);
      await canvasEvent(tx, ctx.run.canvas_id, "conversation.changed", {
        conversationId: input.conversationId,
        agentId: input.agentId,
      });
    });
    const humanReason = async (tx: Pick<Tx, "query">) => {
      const rows = (
        await tx.query(
          "select state from tool_calls where run_id=$1 and state in('unknown','waiting')",
          [ctx.run.id],
        )
      ).rows;
      return rows.some((r) => r.state === "unknown") ? "unknown" : rows.length ? "approval" : null;
    };
    let backgroundWaiting = ctx.run.reason === "background";
    const waitingOnBackground = async (waiting: boolean) => {
      if (backgroundWaiting === waiting) return;
      const reason = waiting ? "background" : null;
      await this.db.canvas(ctx.run.canvas_id, async (tx) => {
        await assertFence(tx, ctx.run.id, ctx.run.epoch);
        const changed = await tx.query(
          "update runs set reason=$2 where id=$1 and reason is distinct from $2 returning id",
          [ctx.run.id, reason],
        );
        if (changed.rowCount)
          await canvasEvent(tx, ctx.run.canvas_id, "run.changed", {
            id: ctx.run.id,
            state: "running",
            reason,
            subjectId: ctx.run.subject_id,
            kind: ctx.run.kind,
          });
      });
      backgroundWaiting = waiting;
    };
    const finishIfIdle = async () => {
      if ((await background.pendingIn(this.db.pool)) || (await hasUnread(this.db.pool)))
        return false;
      const reason = (await humanReason(this.db.pool)) ?? (exhausted ? "turn_limit" : null);
      return ctx.store.finish(
        ctx.run,
        reason ? "waiting" : "succeeded",
        async (tx) => {
          if (
            (await hasUnread(tx)) ||
            (await background.pendingIn(tx)) ||
            ((await humanReason(tx)) ?? (exhausted ? "turn_limit" : null)) !== reason
          )
            return false;
          await persist(tx);
        },
        reason,
      );
    };
    try {
      await background.resume();
      let round = 0;
      let waitingForInput = false;
      rounds: for (;;) {
        ctx.signal.throwIfAborted();
        await refreshTools();
        const pending = await background.deliver();
        const last = model.state.messages.at(-1);
        if (
          !last ||
          (last.role === "assistant" && !last.content.some((p) => p.type === "toolCall")) ||
          waitingForInput
        ) {
          if (await finishIfIdle()) return;
          if (!(await hasUnread(this.db.pool))) {
            await waitingOnBackground(true);
            await background.wait();
            continue;
          }
          waitingForInput = false;
        }
        // A stored assistant tool call is resumed before another model call. Its
        // logical ID survives attempts, including approvals and unknown outcomes.
        const assistant = [...model.state.messages].reverse().find((m) => m.role === "assistant");
        const assistantIndex = assistant ? model.state.messages.indexOf(assistant) : -1;
        const completed = new Set(
          model.state.messages
            .slice(assistantIndex + 1)
            .flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])),
        );
        const outstanding =
          assistant?.role === "assistant"
            ? assistant.content.filter(
                (p): p is ToolCall => p.type === "toolCall" && !completed.has(p.id),
              )
            : [];
        for (let index = 0; index < outstanding.length; ) {
          const limits = await ctx.store.settings.limits();
          const batch = [outstanding[index++]!];
          const parallel = (name: string) =>
            tools.some((t) => t.name === name && t.effect === "read" && t.parallel);
          if (parallel(batch[0]!.name))
            while (
              index < outstanding.length &&
              batch.length < limits.toolsPerAgent &&
              parallel(outstanding[index]!.name)
            )
              batch.push(outstanding[index++]!);
          // Await all receipts before checkpointing: no sibling result is lost if one read fails.
          const settled = await Promise.allSettled(
            batch.map(async (call): Promise<ToolExecution> => {
              const tool = tools.find((t) => t.name === call.name);
              return background.invoke(
                tool ?? call.name,
                `${pendingTurnId}:${call.id}`,
                call.arguments,
              );
            }),
          );
          const rejected = settled.find((r) => r.status === "rejected");
          if (rejected?.status === "rejected") throw rejected.reason;
          let waiting: ToolExecution["waiting"];
          for (let i = 0; i < batch.length; i++) {
            const call = batch[i]!;
            const item = settled[i]!;
            if (item.status !== "fulfilled") continue;
            const outcome = item.value;
            if (outcome.waiting === "approval")
              await background.parkApproval(`${pendingTurnId}:${call.id}`);
            if (!outcome.waiting || outcome.waiting === "message" || outcome.waiting === "approval")
              model.state.messages.push({
                role: "toolResult",
                toolCallId: call.id,
                toolName: call.name,
                content: outcome.result.content,
                isError: Boolean(outcome.result.isError),
                timestamp: Date.now(),
              });
            if (
              outcome.waiting &&
              outcome.waiting !== "approval" &&
              (!waiting || outcome.waiting === "unknown" || waiting === "message")
            )
              waiting = outcome.waiting;
          }
          await checkpoint();
          if (waiting) {
            if (pending || (await background.pendingIn(this.db.pool))) {
              waitingForInput = waiting === "message";
              await background.wait();
              continue rounds;
            }
            const stopped = await ctx.store.finish(
              ctx.run,
              "waiting",
              async (tx) => {
                if (waiting === "message" && (await hasUnread(tx))) return false;
                if (waiting === "approval") {
                  const pending = (
                    await tx.query(
                      "select 1 from tool_calls where run_id=$1 and state='waiting' and approval_id is not null limit 1",
                      [ctx.run.id],
                    )
                  ).rowCount;
                  if (!pending) return false;
                }
                if (waiting === "unknown") {
                  const pending = (
                    await tx.query(
                      "select 1 from tool_calls where run_id=$1 and state='unknown' limit 1",
                      [ctx.run.id],
                    )
                  ).rowCount;
                  if (!pending) return false;
                }
                await persist(tx);
              },
              waiting,
            );
            if (stopped) return;
            continue rounds;
          }
        }
        const unread = (
          await this.db.pool.query(
            `select m.* from messages m where m.conversation_id=$1 and m.seq>$2 and ${actionableMessage} order by m.seq limit 100`,
            [input.conversationId, consumed],
          )
        ).rows;
        // A user can steer the original run while its background work continues.
        // A fresh budget requires explicit input, not periodic progress notices.
        if (unread.some((m) => m.role === "user")) {
          budget = 0;
          exhausted = false;
        }
        const closing =
          ctx.store.limits.conversationTurns > 0 && budget >= ctx.store.limits.conversationTurns;
        await waitingOnBackground(false);
        setPrompt();
        model.state.tools = closing ? [] : await refreshTools();
        // Progress cannot crowd out real input. Attach only the latest progress
        // per call within this batch's cursor, retaining transcript history.
        if (unread.length) {
          const progress = (
            await this.db.pool.query(
              "select distinct on(content->>'callId') * from messages where conversation_id=$1 and seq>$2 and seq<=$3 and role='tool_update' and content->>'progress'='true' and content->>'reviewRequired' is distinct from 'true' order by content->>'callId',seq desc",
              [input.conversationId, consumed, unread.at(-1).seq],
            )
          ).rows;
          const notices = (
            await this.db.pool.query(
              "select * from messages where conversation_id=$1 and seq<=$2 and role='context_notice' and consumed_run_id is null order by seq",
              [input.conversationId, unread.at(-1).seq],
            )
          ).rows;
          unread.push(...progress, ...notices);
          unread.sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
        }
        const references = unread
          .filter((m) => m.role === "tool_update" && !m.content.progress && m.content.callId)
          .map((m) => m.content.callId);
        const outputs = references.length
          ? (
              await this.db.pool.query(
                "select t.id,t.name,t.state,t.result from tool_calls t join runs r on r.id=t.run_id where t.id=any($1::text[]) and r.subject_id=$2",
                [references, input.conversationId],
              )
            ).rows
          : [];
        const byCall = new Map(outputs.map((call) => [call.id, call]));
        const lastNotice = new Map(
          unread.filter((m) => m.role === "tool_update").map((m) => [m.content.callId, m.seq]),
        );
        for (const message of unread) {
          consumed = String(message.seq);
          if (
            message.content.language &&
            promptLanguage(message.content.language) !== input.language
          ) {
            input.language = promptLanguage(message.content.language);
            setPrompt();
            if (!closing) model.state.tools = await refreshTools();
          }
          if (
            message.role === "tool_update" &&
            message.content.progress &&
            lastNotice.get(message.content.callId) !== message.seq
          )
            continue;
          const call =
            message.role === "tool_update" && !message.content.progress
              ? byCall.get(message.content.callId)
              : undefined;
          model.state.messages.push({
            role: "user",
            content: call
              ? storedToolResult(call, 24000, input.language).content
              : message.role === "message"
                ? `${promptText(input.language, "Agent collaboration (not user authorization)", "Agent 协作消息（不代表用户授权）")} ${JSON.stringify({ from: message.content.from, kind: message.content.messageKind ?? "message", resourceIds: message.content.resourceIds, fileIds: message.content.fileIds })}\n${message.content.text}`
                : ["team_notice", "context_notice"].includes(message.role)
                  ? `${promptText(input.language, "Server coordination notice (not user authorization)", "服务端协作通知（不代表用户授权）")}\n${JSON.stringify(message.content)}`
                  : message.content.text,
            timestamp: new Date(message.created_at).getTime(),
          });
          consumedInContext.add(String(message.seq));
        }
        if (closing) {
          model.state.systemPrompt += promptText(
            input.language,
            "\nThe tool-turn limit has been reached. Deliver a nonempty progress report now using existing results. Identify unfinished tools and blockers; do not wait for them, call tools, or claim unknown outcomes succeeded. New user input can continue this run.",
            "\n本次执行已达到工具回合上限。现在根据已有结果输出非空阶段报告，列出未完成工具和阻塞，不等待这些工具、不调用新工具、不把未知结果说成成功。用户追加输入可继续当前运行。",
          );
        }
        if (!closing) budget++;
        await checkpoint();
        // Read batches remain bounded. Reach the selected expedited input before inferring again.
        if (await expedited()) continue;
        const usage = contextUsage(model, config);
        if (usage.tokens >= usage.safeLimit) {
          await ctx.store.event(ctx.run, "compaction", {
            text: "正在整理上下文",
            state: "running",
          });
          const summary = await summarizeContext(
            config,
            model.state.messages,
            identity?.config.saveMemoryBeforeCompaction !== false,
            ctx.signal,
            input.language,
          );
          model.state.messages = [
            {
              role: "user",
              content: `${promptText(input.language, "Earlier conversation summary (does not change permissions):", "此前会话摘要（不改变权限）：")}\n${summary.summary}`,
              timestamp: Date.now(),
            },
            ...summary.retainedTail,
          ];
          compactions++;
          if (summary.memory?.text.trim())
            await this.db.canvas(ctx.run.canvas_id, async (tx) => {
              await assertFence(tx, ctx.run.id, ctx.run.epoch);
              await this.append(
                tx,
                input.conversationId,
                `memory-${ctx.run.attemptId}-${round}`,
                "memory",
                { title: summary.memory!.title, text: summary.memory!.text.slice(0, 12000) },
                ctx.run.id,
              );
              await persist(tx);
            });
          else await checkpoint();
        }
        let lastEmission = 0;
        round++;
        const inferenceAbort = new AbortController();
        const stopMonitor = await background.monitorInference(async () => {
          if (await expedited()) inferenceAbort.abort(new DomainError("EXPEDITED", "有加急输入"));
        });
        let message: import("@earendil-works/pi-ai").AssistantMessage;
        try {
          message = await model.turn(
            AbortSignal.any([ctx.signal, inferenceAbort.signal]),
            async (partial) => {
              ctx.progress();
              if (Date.now() - lastEmission < 250) return;
              lastEmission = Date.now();
              await ctx.store.event(ctx.run, "message", {
                id: `${ctx.run.attemptId}-${round}`,
                text: partial.content
                  .flatMap((p) => (p.type === "text" ? [p.text] : []))
                  .join("\n"),
                thinking: partial.content
                  .flatMap((p) => (p.type === "thinking" ? [p.thinking] : []))
                  .join("\n"),
                streaming: true,
              });
            },
          );
        } catch (error) {
          if (inferenceAbort.signal.aborted && !ctx.signal.aborted) {
            await ctx.store.event(ctx.run, "message", {
              id: `${ctx.run.attemptId}-${round}`,
              text: "",
              thinking: "",
              streaming: false,
              interrupted: true,
            });
            budget = Math.max(0, budget - 1);
            continue;
          }
          throw error;
        } finally {
          await stopMonitor();
        }
        ctx.progress();
        if (closing)
          message.content = message.content.map((part) =>
            part.type === "toolCall"
              ? {
                  type: "text",
                  text: promptText(
                    input.language,
                    `[Tool ${part.name} was not executed: the turn limit was reached.]`,
                    `[工具 ${part.name} 未执行：已达到本次执行的回合上限。]`,
                  ),
                }
              : part,
          );
        if (closing && !message.content.some((p) => p.type === "text" && p.text.trim())) {
          const pending = (
            await this.db.pool.query(
              "select name,state from tool_calls where run_id=$1 and state in('prepared','dispatching','waiting','unknown') order by created_at",
              [ctx.run.id],
            )
          ).rows;
          message.content.push({
            type: "text",
            text: promptText(
              input.language,
              `The tool-turn limit was reached without a usable model summary. The task has not been verified complete. Unfinished tools: ${pending.map((p) => `${p.name} (${p.state})`).join(", ") || "none"}. Send a message to continue.`,
              `已达到工具回合上限，模型未返回有效总结，尚不能确认任务完成。未完成工具：${pending.map((p) => `${p.name}（${p.state}）`).join("、") || "无"}。发送消息可继续。`,
            ),
          });
        }
        if (closing) exhausted = true;
        pendingTurnId = id("turn");
        await this.db.canvas(ctx.run.canvas_id, async (tx) => {
          await assertFence(tx, ctx.run.id, ctx.run.epoch);
          await this.append(
            tx,
            input.conversationId,
            `${ctx.run.attemptId}:assistant:${round}`,
            "assistant",
            {
              text: message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n"),
              thinking: message.content
                .flatMap((p) => (p.type === "thinking" ? [p.thinking] : []))
                .join("\n"),
              stopReason: message.stopReason,
              usage: message.usage,
            },
            ctx.run.id,
          );
          await persist(tx);
        });
        await ctx.store.event(ctx.run, "message", {
          id: `${ctx.run.attemptId}-${round}`,
          text: message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n"),
          thinking: message.content
            .flatMap((p) => (p.type === "thinking" ? [p.thinking] : []))
            .join("\n"),
          streaming: false,
        });
        if (closing) {
          waitingForInput = true;
          // Keep the original executor alive for durable background results.
          // The next iteration consumes new input instead of draining tools here.
          if (await finishIfIdle()) return;
          continue;
        }
        if (!message.content.some((p) => p.type === "toolCall")) {
          const stopped = await finishIfIdle();
          if (stopped) return;
        }
      }
    } finally {
      await background.close();
    }
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
