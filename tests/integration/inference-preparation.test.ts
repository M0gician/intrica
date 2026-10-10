import { expect, it, vi } from "vitest";
import { invokeTool } from "../../apps/server/dist/modules/execution/tool-calls.js";
import * as lifecycle from "../../apps/server/dist/modules/inference/lifecycle.js";
import { expediteInput } from "../../apps/server/dist/modules/work/input-receipts.js";
import { addressedOutput } from "../fixtures/addressed-output.mjs";
import { deferred } from "../fixtures/inference-wire.js";
import { inferenceHarness, key } from "./helpers/inference.js";

const h = inferenceHarness();
it("input accepted before attempt preparation continues the run with zero stale network dispatches", async () => {
  const entered = deferred(),
    release = deferred();
  const open = lifecycle.openAttempt;
  vi.spyOn(lifecycle, "openAttempt").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return open(...args);
  });
  const s = await h.session(),
    before = h.endpoint.requests,
    done = s.execute();
  await entered.promise;
  const inputId = key();
  await h.k.conversations.submit({
    canvasId: s.canvasId,
    conversationId: s.conversationId,
    message: "Input wins preparation",
    key: inputId,
    association: { kind: "append", requestId: s.run.frozen_input.workItemId },
  });
  await expediteInput(h.k.db, s.conversationId, inputId);
  expect(h.endpoint.requests).toBe(before);
  release.resolve();
  const next = await h.nextWhile(done);
  expect(JSON.stringify(next.body)).toContain("Input wins preparation");
  next.start();
  next.answer(addressedOutput(JSON.stringify(next.body), "Resumed from current input"));
  await done;
  expect(h.endpoint.requests).toBe(before + 1);
  const requests = (
    await h.k.db.pool.query("select state from inference_requests where run_id=$1", [s.run.id])
  ).rows;
  expect(requests).toEqual([{ state: "sealed" }]);
});

it("tool origin and input-repair budgets remain bound to the original task, including taskless calls", async () => {
  const s = await h.session();
  const read = (await h.k.tools.create(s.ctx, s.run.frozen_input)).find(
    (tool) => tool.name === "read_canvas",
  )!;
  const originalWork = s.run.frozen_input.workItemId;
  s.run.frozen_input.workItemId = "current-task";
  const ids: string[] = [],
    remaining: number[] = [];
  for (const workItemId of [null, originalWork, null]) {
    const logical = key();
    ids.push(logical);
    const output = await invokeTool(
      s.ctx,
      read,
      logical,
      { invalidField: true },
      undefined,
      undefined,
      undefined,
      { workItemId },
    );
    expect(output.result.isError).toBe(true);
    remaining.push(
      JSON.parse((output.result.content[0] as { text: string }).text).repairsRemaining,
    );
  }
  expect(remaining).toEqual([2, 2, 1]);
  const rows = (
    await h.k.db.pool.query(
      "select logical_call_id,work_item_id,retry_of from tool_calls where run_id=$1",
      [s.run.id],
    )
  ).rows;
  const byId = new Map(rows.map((row) => [row.logical_call_id, row]));
  expect(ids.map((id) => byId.get(id).work_item_id)).toEqual([null, originalWork, null]);
  expect(byId.get(ids[1]).retry_of).toBeNull();
  expect(byId.get(ids[2]).retry_of).toBeTruthy();
});
