import { expect, it } from "vitest";
import { createCanvasAgent } from "../../apps/server/dist/adapters/model/agent.js";
import { contextUsage } from "../../apps/server/dist/adapters/model/context.js";
import { summaryMessage } from "../../apps/server/dist/modules/context/messages.js";
import { createCheckpointWriter } from "../../apps/server/dist/modules/work/conversation-runtime/checkpoints.js";
import { compactConversation } from "../../apps/server/dist/modules/work/conversation-runtime/compaction.js";
import {
  instructionSources,
  withOriginalInstructions,
} from "../../apps/server/dist/modules/work/progress/sources.js";
import { agent, consume, k, key, start } from "./helpers/runtime-redesign.js";

const config = { kind: "mock", streamDelayMs: 0, supportsVision: false } as const;
async function fixture(large = true) {
  const session = await start((await agent()).id);
  await consume(session);
  const controller = new AbortController();
  session.ctx.signal = controller.signal;
  const input = session.run.frozen_input;
  const model = createCanvasAgent(config, key());
  const content = {
    facts: ["Verified prior decision"],
    decisions: [],
    completed_work: [],
    remaining_work: [],
    source_refs: ["s1"],
  };
  const prior = summaryMessage(model.state.model, key(), content, "en");
  const { intrica: _metadata, ...base } = prior;
  const row = (
    await k.db.pool.query("select * from conversations where id=$1", [session.run.subject_id])
  ).rows[0];
  const sources = await instructionSources(k.db.pool, row.id, row.consumed_message_seq);
  model.state.messages = withOriginalInstructions(
    [
      prior,
      ...(large
        ? ([
            {
              ...base,
              role: "assistant",
              stopReason: "toolUse",
              content: [
                { type: "toolCall", id: "read", name: "read", arguments: { path: "fixture.txt" } },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "read",
              toolName: "read",
              content: [{ type: "text", text: "x".repeat(500000) }],
              isError: false,
              timestamp: 0,
            },
          ] as any[])
        : []),
    ],
    sources,
    "en",
  );
  await k.db.pool.query(
    "insert into context_summaries(id,conversation_id,run_id,request_id,source_hash,source_refs,instruction_hash,content,previous_checkpoint,context_version) values($1,$2,$3,$4,'prior','[]','prior',$5,'[]',0)",
    [prior.intrica!.id, row.id, session.run.id, key(), JSON.stringify(content)],
  );
  await k.db.pool.query(
    "update conversations set checkpoint=$2,context_version=1,context=$3 where id=$1",
    [row.id, JSON.stringify(model.state.messages), JSON.stringify({ compactions: 1 })],
  );
  const saved = async () => ({
    conversation: (
      await k.db.pool.query(
        "select checkpoint,context,context_version from conversations where id=$1",
        [row.id],
      )
    ).rows[0],
    summaries: (
      await k.db.pool.query(
        "select id,content,previous_checkpoint,context_version from context_summaries where conversation_id=$1 order by context_version",
        [row.id],
      )
    ).rows,
    memory: (
      await k.db.pool.query(
        "select content from messages where conversation_id=$1 and role='memory'",
        [row.id],
      )
    ).rows,
  });
  const events = async () =>
    (
      await k.db.pool.query(
        "select payload from run_events where run_id=$1 and type='compaction' order by seq",
        [session.run.id],
      )
    ).rows.map((row) => row.payload);
  let count = 1;
  const persist = createCheckpointWriter(
    session.ctx,
    input,
    model,
    config,
    new Set(),
    () => ({
      consumed: String(row.consumed_message_seq),
      compactions: count,
      pendingTurnId: "fixture",
      toolSchemaVersion: 6,
      budget: 0,
      exhausted: false,
    }),
    1,
  );
  return {
    ...session,
    controller,
    model,
    sources,
    saved,
    events,
    persist,
    count: () => count,
    compact: (write = persist) =>
      compactConversation(session.ctx, input, model, config, sources, true, write, (delta) => {
        count += delta;
      }),
  };
}

it("validates and atomically commits a smaller context with original instructions and prior evidence", async () => {
  const f = await fixture();
  const before = await f.saved();
  expect(contextUsage(f.model, config).tokens).toBeGreaterThan(
    contextUsage(f.model, config).safeLimit,
  );
  await f.compact();
  const after = await f.saved();
  expect(after.summaries).toHaveLength(2);
  expect(after.summaries[1].previous_checkpoint).toEqual(before.conversation.checkpoint);
  expect(after.conversation.context_version).toBe("2");
  expect(after.conversation.context.compactions).toBe(2);
  expect(after.memory).toHaveLength(1);
  expect(after.conversation.checkpoint[0].content).toBe("verify");
  expect(contextUsage(f.model, config).tokens).toBeLessThan(
    contextUsage(f.model, config).safeLimit,
  );
  const refs = (
    await k.db.pool.query(
      "select source_refs from context_summaries where conversation_id=$1 order by context_version desc limit 1",
      [f.run.subject_id],
    )
  ).rows[0].source_refs;
  expect(refs.length).toBeGreaterThan(1);
  expect((await f.events()).at(-1)).toMatchObject({
    state: "succeeded",
    phase: "commit",
    sourceCount: refs.length,
    beforeTokens: expect.any(Number),
    afterTokens: expect.any(Number),
    safeLimit: expect.any(Number),
  });
});

it("rejects a candidate that grows context without replacing the valid checkpoint or memory", async () => {
  const f = await fixture(false);
  const before = await f.saved(),
    messages = f.model.state.messages;
  await expect(f.compact()).rejects.toMatchObject({ code: "CONTEXT_COMPACTION_LIMIT" });
  expect(await f.saved()).toEqual(before);
  expect(f.model.state.messages).toBe(messages);
  expect(f.count()).toBe(1);
  expect((await f.events()).at(-1)).toMatchObject({
    state: "failed",
    phase: "candidate",
    code: "CONTEXT_COMPACTION_LIMIT",
    sourceCount: expect.any(Number),
  });
});

it("rejects an over-budget candidate even when it is smaller than the original", async () => {
  const f = await fixture();
  const limit = contextUsage(f.model, config).safeLimit;
  f.model.state.systemPrompt = "x".repeat((limit - 100) * 3);
  const before = await f.saved();
  await expect(f.compact()).rejects.toMatchObject({ code: "CONTEXT_COMPACTION_LIMIT" });
  expect(await f.saved()).toEqual(before);
  expect(f.count()).toBe(1);
  expect((await f.events()).some((event) => event.state === "succeeded")).toBe(false);
});

it("reports genuinely oversized original instructions before requesting a summary", async () => {
  const f = await fixture();
  f.sources[0]!.text = "汉".repeat(60000);
  const before = await f.saved();
  await expect(f.compact()).rejects.toMatchObject({ code: "INSTRUCTION_CONTEXT_LIMIT" });
  expect(await f.saved()).toEqual(before);
});

it("does not blame original instructions when the system prompt consumes the budget", async () => {
  const f = await fixture();
  f.model.state.systemPrompt = "x".repeat(contextUsage(f.model, config).safeLimit * 3);
  const before = await f.saved();
  await expect(f.compact()).rejects.toMatchObject({ code: "CONTEXT_COMPACTION_LIMIT" });
  expect(await f.saved()).toEqual(before);
});

it("rolls back checkpoint, summary, memory and count when cancellation arrives during persistence", async () => {
  const f = await fixture();
  const before = await f.saved(),
    messages = f.model.state.messages;
  await expect(
    f.compact(async (tx) => {
      await f.persist(tx);
      f.controller.abort(new Error("cancelled during checkpoint"));
    }),
  ).rejects.toThrow("cancelled during checkpoint");
  expect(await f.saved()).toEqual(before);
  expect(f.model.state.messages).toBe(messages);
  expect(f.count()).toBe(1);
});

it("preserves the original checkpoint when the execution fence expires before commit", async () => {
  const f = await fixture();
  const before = await f.saved(),
    messages = f.model.state.messages;
  f.model.prepareMessages = async (messages) => {
    await k.db.pool.query("update runs set epoch=epoch+1 where id=$1", [f.run.id]);
    return messages;
  };
  await expect(f.compact()).rejects.toMatchObject({ code: "STALE_EXECUTION" });
  expect(await f.saved()).toEqual(before);
  expect(f.model.state.messages).toBe(messages);
});
