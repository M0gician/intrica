import { expect, it } from "vitest";
import { expediteInput } from "../../apps/server/dist/modules/work/input-receipts.js";
import { conversationTrace } from "../../apps/server/dist/modules/work/trace.js";
import { addressedOutput } from "../fixtures/addressed-output.mjs";
import { call, reasoning } from "../fixtures/inference-wire.js";
import { inferenceHarness, key } from "./helpers/inference.js";

const h = inferenceHarness();

it("native incomplete status prevents tool admission even after an output-item done event", async () => {
  const s = await h.session(),
    done = s.execute();
  const first = await h.nextWhile(done);
  first.start();
  first.item(reasoning("rs_valid", "encrypted-valid"), 0);
  first.item(call("partial", "read_canvas"), 1, false);
  first.event("response.output_item.done", {
    output_index: 1,
    item: { ...call("partial", "read_canvas"), status: "incomplete" },
  });
  await h.watch(s.canvasId, () =>
    h.exists(
      "select 1 from inference_items i join inference_attempts a on a.id=i.attempt_id join inference_requests q on q.id=a.request_id where q.conversation_id=$1 and i.ordinal=1 and i.state='closed'",
      [s.conversationId],
    ),
  );
  expect(
    (await h.k.db.pool.query("select * from tool_calls where run_id=$1", [s.run.id])).rows,
  ).toEqual([]);
  const inputId = key();
  await h.k.conversations.submit({
    canvasId: s.canvasId,
    conversationId: s.conversationId,
    message: "Replace the incomplete decision",
    key: inputId,
    association: { kind: "append", requestId: s.run.frozen_input.workItemId },
  });
  await expediteInput(h.k.db, s.conversationId, inputId);
  first.response.destroy();
  const next = await h.nextWhile(done);
  expect(
    next.body.input.some((item: any) => item.type === "function_call" || item.type === "reasoning"),
  ).toBe(false);
  next.start();
  next.answer(addressedOutput(JSON.stringify(next.body), "Updated safely"));
  await done;
});

it("cutover retains a native committed group, discards partial thinking, and consumes two original inputs once in order", async () => {
  const s = await h.session(),
    done = s.execute();
  const first = await h.nextWhile(done);
  first.start();
  first.item(reasoning("rs_complete", "encrypted-A"), 0);
  first.item(call("complete", "read_canvas"), 1);
  first.item(reasoning("rs_partial"), 2, false);
  first.event("response.reasoning_summary_text.delta", {
    item_id: "rs_partial",
    output_index: 2,
    summary_index: 0,
    delta: "PARTIAL_ONLY",
  });
  await h.watch(s.canvasId, () =>
    h.exists(
      "select 1 from inference_items i join inference_attempts a on a.id=i.attempt_id join inference_requests q on q.id=a.request_id where q.conversation_id=$1 and i.ordinal=2 and i.state='streaming'",
      [s.conversationId],
    ),
  );
  const added: string[] = [];
  for (const text of ["FIRST_URGENT_INPUT", "SECOND_URGENT_INPUT"]) {
    const id = key();
    added.push(id);
    await h.k.conversations.submit({
      canvasId: s.canvasId,
      conversationId: s.conversationId,
      message: text,
      key: id,
      association: { kind: "append", requestId: s.run.frozen_input.workItemId },
    });
    await expediteInput(h.k.db, s.conversationId, id);
  }
  first.response.destroy();
  const next = await h.nextWhile(done);
  const payload = JSON.stringify(next.body);
  expect(payload).toContain("encrypted-A");
  expect(payload).not.toContain("PARTIAL_ONLY");
  expect(payload).not.toContain("rs_partial");
  const input = next.body.input;
  expect(
    input.filter((i: any) => i.type === "function_call" && i.call_id === "call_complete"),
  ).toHaveLength(1);
  expect(
    input.filter((i: any) => i.type === "function_call_output" && i.call_id === "call_complete"),
  ).toHaveLength(1);
  const user = input
    .filter((i: any) => i.role === "user")
    .map((i: any) => JSON.stringify(i.content));
  expect(user.filter((m: string) => m.includes("FIRST_URGENT_INPUT"))).toHaveLength(1);
  expect(user.filter((m: string) => m.includes("SECOND_URGENT_INPUT"))).toHaveLength(1);
  expect(user.findIndex((m: string) => m.includes("FIRST_URGENT_INPUT"))).toBeLessThan(
    user.findIndex((m: string) => m.includes("SECOND_URGENT_INPUT")),
  );
  next.start();
  next.answer(addressedOutput(payload, "Verified cutover"));
  await done;
  const entries = (
    await h.k.db.pool.query(
      "select role,content,consumed_at from messages where conversation_id=$1 order by seq",
      [s.conversationId],
    )
  ).rows;
  expect(
    entries
      .filter((r) => r.role === "inference_item" && r.content.itemKind === "thinking")
      .map((r) => r.content.state),
  ).toEqual(["committed", "discarded"]);
  expect(entries.filter((r) => r.role === "assistant").map((r) => r.content.text)).toEqual([
    "Verified cutover",
  ]);
  const manifests = (
    await h.k.db.pool.query(
      "select manifest from model_calls where run_id=$1 order by started_at",
      [s.run.id],
    )
  ).rows;
  expect(manifests).toHaveLength(2);
  expect(manifests[1].manifest.inputIds.map((r: any) => r.id)).toEqual([s.inputId, ...added]);
  expect(manifests[1].manifest.itemVersions).toHaveLength(2);
  expect(BigInt(manifests[1].manifest.contextSeq)).toBeGreaterThan(0n);
  expect(
    (await h.k.db.pool.query("select * from tool_calls where run_id=$1", [s.run.id])).rows,
  ).toHaveLength(1);
  const trace = await conversationTrace(h.k.db, s.conversationId);
  expect(trace.models.map((call) => call.inference_attempt_id).sort()).toEqual(
    trace.inferenceAttempts.map((attempt) => attempt.id).sort(),
  );
  expect(
    trace.inputs
      .filter((input) => added.includes(input.id))
      .map((input) => input.cutover_request_id),
  ).toEqual(added.map(() => trace.models[0].generation_id));
  expect(trace.tools[0]).toMatchObject({
    inference_item_id: trace.outputItems.find((item) => item.kind === "toolCall")!.id,
    has_primary_response: true,
  });
  expect(JSON.stringify(trace)).not.toContain("encrypted-A");
  expect(JSON.stringify(trace)).not.toContain("PARTIAL_ONLY");
});

it("a closed reasoning item remains pending until terminal encrypted continuation arrives during drain", async () => {
  const s = await h.session(),
    done = s.execute();
  const first = await h.nextWhile(done);
  first.start();
  first.item(reasoning("rs_late"), 0);
  first.item(call("late", "read_canvas"), 1);
  await h.watch(s.canvasId, () =>
    h.exists(
      "select 1 from inference_items i join inference_attempts a on a.id=i.attempt_id join inference_requests q on q.id=a.request_id where q.conversation_id=$1 and i.ordinal=1 and i.state='closed'",
      [s.conversationId],
    ),
  );
  const added = key();
  await h.k.conversations.submit({
    canvasId: s.canvasId,
    conversationId: s.conversationId,
    message: "Use the updated input",
    key: added,
    association: { kind: "append", requestId: s.run.frozen_input.workItemId },
  });
  await expediteInput(h.k.db, s.conversationId, added);
  first.finish([reasoning("rs_late", "encrypted-late"), call("late", "read_canvas")]);
  const next = await h.nextWhile(done);
  expect(JSON.stringify(next.body)).toContain("encrypted-late");
  expect(
    (
      await h.k.db.pool.query("select state,result,dispatched_at from tool_calls where run_id=$1", [
        s.run.id,
      ])
    ).rows,
  ).toEqual([expect.objectContaining({ state: "failed", dispatched_at: null })]);
  expect(JSON.stringify(next.body)).toContain("superseded_before_dispatch");
  next.start();
  next.answer(addressedOutput(JSON.stringify(next.body), "Updated"));
  await done;
});
