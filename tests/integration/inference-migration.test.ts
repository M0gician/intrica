import { expect, it } from "vitest";
import { persistContext } from "../../apps/server/dist/modules/inference/context-projection.js";
import { removeInferenceSchema } from "../fixtures/remove-inference-schema.mjs";
import { inferenceHarness } from "./helpers/inference.js";

const h = inferenceHarness();
it("schema 15 upgrades preserve the checkpoint, queued inputs and task identity", async () => {
  const s = await h.session();
  const history = [
    { role: "user" as const, content: "Saved context before upgrade", timestamp: 1 },
  ];
  await h.k.db.pool.query("update conversations set checkpoint=$2 where id=$1", [
    s.conversationId,
    JSON.stringify(history),
  ]);
  await h.k.db.transaction(async (tx) => {
    await removeInferenceSchema(tx);
    await tx.query(
      "alter table schema_info drop constraint schema_info_version_check; update schema_info set version=15; alter table schema_info add constraint schema_info_version_check check(version=15)",
    );
  });
  await h.k.db.migrate();
  await h.k.db.migrate();
  expect((await h.k.db.pool.query("select version from schema_info")).rows[0].version).toBe(16);
  const saved = (
    await h.k.db.pool.query("select checkpoint,context_seq from conversations where id=$1", [
      s.conversationId,
    ])
  ).rows[0];
  expect(saved).toEqual({ checkpoint: history, context_seq: "0" });
  expect(
    (
      await h.k.db.pool.query("select consumed_at,content from messages where conversation_id=$1", [
        s.conversationId,
      ])
    ).rows,
  ).toEqual([
    expect.objectContaining({
      consumed_at: null,
      content: expect.objectContaining({ workItemId: s.run.frozen_input.workItemId }),
    }),
  ]);
  await h.k.db.canvas(s.canvasId, (tx) => persistContext(tx, s.conversationId, history));
  expect(
    (
      await h.k.db.pool.query("select seq,message from context_entries where conversation_id=$1", [
        s.conversationId,
      ])
    ).rows,
  ).toEqual([
    { seq: "1", message: { role: "user", content: "Saved context before upgrade", timestamp: 1 } },
  ]);
});
