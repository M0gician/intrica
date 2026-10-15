import { DomainError } from "../../../adapters/postgres/database.js";
import { type PromptLanguage, promptText } from "../../../prompt-language.js";
import { appendMessage } from "../../execution/messages.js";
import type { ExecutionContext } from "../../execution/worker.js";
import { sealContextTools } from "./context-tools.js";

/** A failed compaction never turns into an automatic inbox/retry loop. */
export async function pauseContextFailure(
  ctx: ExecutionContext,
  error: unknown,
  language: PromptLanguage,
  stopBackground: () => Promise<void> = async () => {},
) {
  ctx.signal.throwIfAborted();
  const code =
    error instanceof DomainError
      ? error.code
      : error instanceof Error
        ? /^(CONTEXT_[A-Z_]+|MODEL_[A-Z_]+|INSTRUCTION_CONTEXT_LIMIT)/.exec(error.message)?.[1]
        : undefined;
  if (!code || code === "MODEL_RUN_EXPIRED" || code === "MODEL_IDENTITY_CONFLICT") throw error;
  await stopBackground();
  ctx.signal.throwIfAborted();
  return ctx.store.finish(
    ctx.run,
    "waiting",
    async (tx) => {
      await sealContextTools(tx, ctx.run.id);
      await appendMessage(
        tx,
        ctx.run.subject_id,
        `context-blocked-${ctx.run.id}-${ctx.run.epoch}`,
        "context_notice",
        {
          code,
          text: promptText(
            language,
            "Context compaction could not produce a safe continuation. The original checkpoint and completed tool receipts are preserved. Inspect the diagnostic, adjust the model or scope if needed, then continue explicitly to start a new bounded attempt.",
            "上下文压缩未能生成可安全继续的结果。原始会话记录与已完成工具回执已保留。请检查诊断，必要时调整模型或范围，再明确继续，启动新的一次有界尝试。",
          ),
          language,
        },
        ctx.run.id,
      );
      await ctx.store.eventTx(tx, ctx.run.id, ctx.run.attemptId, "context.blocked", { code });
    },
    "context_blocked",
  );
}
