import { Type } from "typebox";
import { expect, it } from "vitest";
import { withModelUsage } from "../../apps/server/dist/adapters/model/usage.js";
import { result } from "../../apps/server/dist/modules/execution/tool-calls.js";
import { addressedOutput } from "../fixtures/addressed-output.mjs";
import { call, deferred, reasoning } from "../fixtures/inference-wire.js";
import { inferenceHarness, key } from "./helpers/inference.js";

const h = inferenceHarness();

it("lease loss after dispatch holds an unknown effect, then resumes from an explicitly verified receipt", async () => {
  const entered = deferred(),
    release = deferred();
  let executions = 0;
  const s = await h.session((tools) =>
    tools.push({
      name: "fixture_effect",
      label: "effect",
      description: "A controlled side effect",
      effect: "external",
      parameters: Type.Object({}),
      execute: async () => {
        executions++;
        entered.resolve();
        await release.promise;
        return result({ actualEffect: true });
      },
    }),
  );
  const done = s.execute(),
    interrupted = expect(done).rejects.toMatchObject({ code: "STALE_EXECUTION" });
  const first = await h.nextWhile(done);
  first.start();
  first.item(reasoning("rs_effect", "encrypted-effect"), 0);
  first.item(call("effect", "fixture_effect"), 1);
  await entered.promise;
  await h.k.db.pool.query(
    "update runs set lease_until=clock_timestamp()-interval '1 second' where id=$1",
    [s.run.id],
  );
  await h.k.runs.recover();
  expect((await h.k.runs.get(s.run.id)).reason).toBe("unknown");
  expect(await h.k.runs.claim("blocked-restart")).toBeNull();
  release.resolve();
  first.response.destroy();
  await interrupted;
  const stored = (await h.k.db.pool.query("select * from tool_calls where run_id=$1", [s.run.id]))
    .rows;
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ state: "unknown", primary_response: null });
  expect(executions).toBe(1);
  await h.k.conversations.resolveUnknown(stored[0].id, "done", "Verified the original effect");
  await h.k.conversations.submit({
    canvasId: s.canvasId,
    conversationId: s.conversationId,
    message: "Continue after verification",
    key: key(),
    association: { kind: "append", requestId: s.run.frozen_input.workItemId },
  });
  const run = (await h.k.runs.claim("verified-restart"))!;
  const ctx = { ...s.ctx, run };
  const resumed = withModelUsage(
    {
      db: h.k.db,
      purpose: "conversation",
      model: run.frozen_input.model,
      runId: run.id,
      attemptId: run.attemptId,
      canvasId: s.canvasId,
      conversationId: s.conversationId,
    },
    () => h.k.conversations.execute(ctx, (ctx, input) => h.k.tools.create(ctx, input)),
  );
  const next = await h.nextWhile(resumed);
  const replies = next.body.input.filter((item: any) => item.type === "function_call_output");
  expect(replies).toHaveLength(1);
  expect(replies[0].output).toContain("Verified the original effect");
  next.start();
  next.answer(addressedOutput(JSON.stringify(next.body), "Verified work retained"));
  await resumed;
  expect(executions).toBe(1);
  const after = (await h.k.db.pool.query("select * from tool_calls where run_id=$1", [s.run.id]))
    .rows[0];
  expect(after.primary_response).toMatchObject({
    toolCallId: "call_effect|fc_effect",
    isError: false,
  });
});
