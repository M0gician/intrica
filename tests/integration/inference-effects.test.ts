import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { result } from "../../apps/server/dist/modules/execution/tool-calls.js";
import * as retry from "../../apps/server/dist/modules/inference/retry-policy.js";
import { expediteInput } from "../../apps/server/dist/modules/work/input-receipts.js";
import { addressedOutput } from "../fixtures/addressed-output.mjs";
import { call, deferred, reasoning } from "../fixtures/inference-wire.js";
import { inferenceHarness, key } from "./helpers/inference.js";

const h = inferenceHarness();

it("an effect started before cutover has one primary running response and one associated final update", async () => {
  const entered = deferred(),
    release = deferred();
  let executions = 0;
  const s = await h.session((tools) =>
    tools.push({
      name: "fixture_effect",
      label: "effect",
      description: "A controlled effect",
      effect: "external",
      parameters: Type.Object({}),
      execute: async () => {
        executions++;
        entered.resolve();
        await release.promise;
        return result({ finished: true });
      },
    }),
  );
  const done = s.execute();
  const first = await h.nextWhile(done);
  first.start();
  first.item(reasoning("rs_effect", "encrypted-effect"), 0);
  first.item(call("effect", "fixture_effect"), 1);
  await entered.promise;
  const inputId = key();
  await h.k.conversations.submit({
    canvasId: s.canvasId,
    conversationId: s.conversationId,
    message: "Inspect new input while the effect finishes",
    key: inputId,
    association: { kind: "append", requestId: s.run.frozen_input.workItemId },
  });
  await expediteInput(h.k.db, s.conversationId, inputId);
  first.response.destroy();
  const next = await h.nextWhile(done);
  const responses = next.body.input.filter((item: any) => item.type === "function_call_output");
  expect(responses).toHaveLength(1);
  expect(JSON.parse(responses[0].output)).toMatchObject({ status: "running", asynchronous: true });
  expect(executions).toBe(1);
  release.resolve();
  await h.watch(s.canvasId, () =>
    h.exists("select 1 from tool_calls where run_id=$1 and state='succeeded'", [s.run.id]),
  );
  next.start();
  next.answer(addressedOutput(JSON.stringify(next.body), "New input received", "update"));
  const final = await h.nextWhile(done);
  expect(final.body.input.filter((item: any) => item.type === "function_call_output")).toHaveLength(
    1,
  );
  expect(JSON.stringify(final.body.input.filter((item: any) => item.role === "user"))).toContain(
    "finished",
  );
  final.start();
  final.answer(addressedOutput(JSON.stringify(final.body), "Effect verified"));
  await done;
  expect(executions).toBe(1);
  const row = (await h.k.db.pool.query("select * from tool_calls where run_id=$1", [s.run.id]))
    .rows[0];
  expect(row.state).toBe("succeeded");
  expect(JSON.parse(row.primary_response.content[0].text)).toMatchObject({ status: "running" });
  expect(row.work_item_id).toBe(s.run.frozen_input.workItemId);
});

it("timeout after a committed effect continues from saved native history and the original receipt", async () => {
  let executions = 0;
  vi.spyOn(retry, "backoff").mockResolvedValue();
  const s = await h.session((tools) =>
    tools.push({
      name: "fixture_effect",
      label: "effect",
      description: "One durable effect",
      effect: "external",
      parameters: Type.Object({}),
      execute: async () => {
        executions++;
        return result({ committedEffect: true });
      },
    }),
  );
  const done = s.execute(),
    first = await h.nextWhile(done);
  first.start();
  first.item(reasoning("rs_retry", "encrypted-retry"), 0);
  first.item(call("retry", "fixture_effect"), 1);
  await h.watch(s.canvasId, () =>
    h.exists("select 1 from tool_calls where run_id=$1 and primary_response is not null", [
      s.run.id,
    ]),
  );
  first.event("error", { code: "ETIMEDOUT", message: "Model request timed out" });
  first.response.end();
  const next = await h.nextWhile(done);
  expect(JSON.stringify(next.body)).toContain("encrypted-retry");
  expect(JSON.stringify(next.body)).toContain("committedEffect");
  expect(next.body.input.filter((item: any) => item.type === "function_call_output")).toHaveLength(
    1,
  );
  next.start();
  next.answer(addressedOutput(JSON.stringify(next.body), "Recovered"));
  await done;
  expect(executions).toBe(1);
  const attempts = (
    await h.k.db.pool.query(
      "select a.* from inference_attempts a join inference_requests q on q.id=a.request_id where q.run_id=$1 order by a.created_at",
      [s.run.id],
    )
  ).rows;
  expect(attempts).toHaveLength(2);
  expect(attempts[0].request_id).toBe(attempts[1].request_id);
  expect(attempts.map((a) => a.outcome)).toEqual(["continue", "completed"]);
  expect(BigInt(attempts[1].context_seq)).toBeGreaterThan(BigInt(attempts[0].context_seq));
});

it("expedite interrupts retry backoff before the next network dispatch", async () => {
  const backoffEntered = deferred();
  vi.spyOn(retry, "backoff").mockImplementation(async (_ms, signal) => {
    backoffEntered.resolve();
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      if (signal.aborted) resolve();
    });
  });
  const s = await h.session(),
    done = s.execute();
  const first = await h.nextWhile(done);
  first.start();
  first.event("error", { code: "ETIMEDOUT", message: "Model request timed out" });
  first.response.end();
  await backoffEntered.promise;
  const inputId = key();
  await h.k.conversations.submit({
    canvasId: s.canvasId,
    conversationId: s.conversationId,
    message: "INPUT_DURING_BACKOFF",
    key: inputId,
    association: { kind: "append", requestId: s.run.frozen_input.workItemId },
  });
  await expediteInput(h.k.db, s.conversationId, inputId);
  const next = await h.nextWhile(done);
  expect(JSON.stringify(next.body)).toContain("INPUT_DURING_BACKOFF");
  next.start();
  next.answer(addressedOutput(JSON.stringify(next.body), "Handled urgent input"));
  await done;
  const rows = (
    await h.k.db.pool.query("select state from inference_requests where run_id=$1", [s.run.id])
  ).rows;
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.state === "sealed")).toBe(true);
});
