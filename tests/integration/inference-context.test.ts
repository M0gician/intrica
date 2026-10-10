import { expect, it, vi } from "vitest";
import * as context from "../../apps/server/dist/adapters/model/context.js";
import { persistContext } from "../../apps/server/dist/modules/inference/context-projection.js";
import type { ContextMessage } from "../../apps/server/dist/modules/inference/types.js";
import { addressedOutput } from "../fixtures/addressed-output.mjs";
import { inferenceHarness, key } from "./helpers/inference.js";

const h = inferenceHarness();

it("context metadata left by a rollback cannot reference another committed entry", async () => {
  const s = await h.session();
  const original: ContextMessage[] = [{ role: "user", content: "Original input", timestamp: 1 }];
  await expect(
    h.k.db.canvas(s.canvasId, async (tx) => {
      await persistContext(tx, s.conversationId, original);
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  expect(original[0]!.intrica?.contextSeq).toBe("1");
  const other: ContextMessage[] = [{ role: "user", content: "Other input", timestamp: 2 }];
  await h.k.db.canvas(s.canvasId, (tx) => persistContext(tx, s.conversationId, other));
  await h.k.db.canvas(s.canvasId, (tx) => persistContext(tx, s.conversationId, original));
  expect(original[0]!.intrica?.contextSeq).toBe("2");
  await h.k.db.canvas(s.canvasId, (tx) => persistContext(tx, s.conversationId, original));
  const entries = (
    await h.k.db.pool.query(
      "select seq,message from context_entries where conversation_id=$1 order by seq",
      [s.conversationId],
    )
  ).rows;
  expect(entries.map((row) => [row.seq, row.message.content])).toEqual([
    ["1", "Other input"],
    ["2", "Original input"],
  ]);
});

it("compaction uses a fixed source and appends new unread input once before the successor request", async () => {
  const s = await h.session();
  const history: ContextMessage[] = Array.from({ length: 40 }, (_, index) => ({
    role: "user",
    content: `Previous observation ${index}: ${"evidence ".repeat(250)}`,
    timestamp: index + 1,
  }));
  await h.k.db.canvas(s.canvasId, async (tx) => {
    await persistContext(tx, s.conversationId, history);
    await tx.query("update conversations set checkpoint=$2 where id=$1", [
      s.conversationId,
      JSON.stringify(history),
    ]);
  });
  const originalUsage = context.contextUsage;
  vi.spyOn(context, "contextUsage").mockImplementation(
    (model, config, messages = model.state.messages) => {
      const usage = originalUsage(model, config, messages);
      return messages.length > 30 ? { ...usage, tokens: usage.safeLimit + 1 } : usage;
    },
  );
  const done = s.execute();
  const summary = await h.nextWhile(done);
  expect(summary.body.tools ?? []).toHaveLength(0);
  expect(summary.body.input.filter((item: any) => item.role === "user")).toHaveLength(1);
  const inputId = key();
  await h.k.conversations.submit({
    canvasId: s.canvasId,
    conversationId: s.conversationId,
    message: "New evidence received during compaction",
    key: inputId,
    association: { kind: "append", requestId: s.run.frozen_input.workItemId },
  });
  expect(
    (
      await h.k.db.pool.query(
        "select consumed_at from messages where conversation_id=$1 and client_message_id=$2",
        [s.conversationId, inputId],
      )
    ).rows[0].consumed_at,
  ).toBeNull();
  expect(JSON.stringify(summary.body)).not.toContain("New evidence received during compaction");
  summary.start();
  summary.answer("Earlier work and observations summarized.");
  const next = await h.nextWhile(done);
  expect(
    next.body.input.filter((item: any) =>
      JSON.stringify(item).includes("New evidence received during compaction"),
    ),
  ).toHaveLength(1);
  next.start();
  next.answer(addressedOutput(JSON.stringify(next.body), "Included the new evidence"));
  await done;
  const calls = (
    await h.k.db.pool.query(
      "select purpose,manifest from model_calls where run_id=$1 order by started_at",
      [s.run.id],
    )
  ).rows;
  expect(calls.map((row) => row.purpose)).toEqual(["compaction", "conversation"]);
  const source = calls[0].manifest.entries[0];
  expect(source.snapshotContextSeq).toBe("41");
  expect(source.compactionSource).toMatchObject({
    hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    excerpt: null,
  });
  expect(calls[1].manifest.inputIds.filter((input: any) => input.id === inputId)).toHaveLength(1);
  const retained = calls[1].manifest.entries
    .filter((entry: any) => entry.contextSeq && entry.role !== "assistant")
    .map((entry: any) => entry.contextSeq);
  expect(source.coveredContextSeqs.every((seq: string) => !retained.includes(seq))).toBe(true);
  expect(source.coveredContextSeqs.length).toBeGreaterThan(0);
});
