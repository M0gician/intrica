import { expect, it, vi } from "vitest";
import { ModelDiagnostics } from "../../apps/server/dist/adapters/model/diagnostic-manifest.js";
import { MessageService } from "../../apps/server/dist/modules/collaboration/send-message.js";
import { expediteInput } from "../../apps/server/dist/modules/work/input-receipts.js";
import { addressedOutput } from "../fixtures/addressed-output.mjs";
import { deferred } from "../fixtures/inference-wire.js";
import { type InferenceSession, inferenceHarness, key } from "./helpers/inference.js";

const h = inferenceHarness();
async function expedite(s: InferenceSession, message: string) {
  const id = key();
  await h.k.conversations.submit({
    canvasId: s.canvasId,
    conversationId: s.conversationId,
    message,
    key: id,
    association: { kind: "append", requestId: s.run.frozen_input.workItemId },
  });
  await expediteInput(h.k.db, s.conversationId, id);
  return id;
}

it("the final dispatch fence prevents network access after input changes during payload capture", async () => {
  const entered = deferred(),
    release = deferred();
  const original = ModelDiagnostics.prototype.payload;
  vi.spyOn(ModelDiagnostics.prototype, "payload").mockImplementationOnce(async function (
    this: ModelDiagnostics,
    value,
  ) {
    await original.call(this, value);
    entered.resolve();
    await release.promise;
  });
  const before = h.endpoint.requests;
  const s = await h.session(),
    done = s.execute();
  await entered.promise;
  const inputId = await expedite(s, "Apply the new decision before dispatch");
  expect(h.endpoint.requests).toBe(before);
  release.resolve();
  const next = await h.nextWhile(done);
  expect(JSON.stringify(next.body)).toContain("Apply the new decision before dispatch");
  next.start();
  next.answer(addressedOutput(JSON.stringify(next.body), "Current decision"));
  await done;
  expect(h.endpoint.requests).toBe(before + 1);
  const attempts = (
    await h.k.db.pool.query(
      "select a.* from inference_attempts a join inference_requests q on q.id=a.request_id where q.run_id=$1 order by a.created_at",
      [s.run.id],
    )
  ).rows;
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toMatchObject({ state: "sealed", dispatched_at: null, outcome: "cutover" });
  expect(attempts[1].dispatched_at).toBeTruthy();
  const call = (
    await h.k.db.pool.query("select manifest from model_calls where inference_attempt_id=$1", [
      attempts[1].id,
    ])
  ).rows[0];
  expect(call.manifest.inputIds.filter((input: any) => input.id === inputId)).toHaveLength(1);
});

it.each(["cutover", "publication"] as const)(
  "%s wins the publication race with an explicit, durable outcome",
  async (winner) => {
    const entered = deferred(),
      release = deferred();
    const original = MessageService.prototype.send;
    vi.spyOn(MessageService.prototype, "send").mockImplementationOnce(async function (
      this: MessageService,
      ...args
    ) {
      const receipt = winner === "publication" ? await original.apply(this, args) : undefined;
      entered.resolve();
      await release.promise;
      return winner === "publication" ? receipt : original.apply(this, args);
    });
    const s = await h.session(),
      done = s.execute();
    const first = await h.nextWhile(done);
    first.start();
    first.answer(
      JSON.stringify({
        target: { kind: "request", id: s.run.frozen_input.workItemId },
        kind: "update",
        message: "Original progress",
      }),
    );
    await entered.promise;
    await expedite(s, "Use the current input before reporting");
    release.resolve();
    const next = await h.nextWhile(done);
    expect(JSON.stringify(next.body)).toContain("Original progress");
    expect(JSON.stringify(next.body)).toContain("Use the current input before reporting");
    next.start();
    next.answer(addressedOutput(JSON.stringify(next.body), "Current result"));
    await done;
    const published = (
      await h.k.db.pool.query(
        "select content from messages where conversation_id=$1 and role='assistant' order by seq",
        [s.conversationId],
      )
    ).rows.map((row) => row.content.text);
    expect(published).toEqual(
      winner === "publication" ? ["Original progress", "Current result"] : ["Current result"],
    );
    const items = (
      await h.k.db.pool.query(
        "select i.state,i.publication from inference_items i join inference_attempts a on a.id=i.attempt_id join inference_requests q on q.id=a.request_id where q.run_id=$1 and i.kind='text' order by i.created_at",
        [s.run.id],
      )
    ).rows;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      state: "committed",
      publication: winner === "publication" ? { state: "sent" } : {},
    });
    expect(items[1]).toMatchObject({ state: "committed", publication: { state: "sent" } });
  },
);
