import { expect, it } from "vitest";
import { ModelQueue } from "../../apps/server/dist/modules/model-runtime/queue.js";
import { ResponseValidationError } from "../../apps/server/dist/modules/model-runtime/response-validation.js";
import { scheduledStream } from "../../apps/server/dist/modules/model-runtime/stream.js";
import { agent, k, key, start } from "./helpers/runtime-redesign.js";

const response = (text: string) =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: 0,
  }) as any;
const validate = (message: any) => {
  if (!message.content[0]?.text)
    throw new ResponseValidationError(
      "empty",
      "Return a nonempty handoff preserving the pending task.",
    );
};
const model = { id: "test", provider: "custom", api: "openai-completions" } as any;
async function activeRequest() {
  const session = await start((await agent()).id),
    group = key();
  const queue = new ModelQueue(k.db, {
    id: key(),
    runId: session.run.id,
    runEpoch: session.run.epoch,
    conversationId: session.run.subject_id,
    purpose: "compaction",
    endpointId: group,
    endpointKey: group,
    sourceHash: "unchanged-evidence",
  });
  return { session, group, queue };
}

it("recovers an interrupted logical request after worker requeue without resetting correction or admission budgets", async () => {
  const { session, group, queue } = await activeRequest();
  const controller = new AbortController();
  let attempts = 0;
  const interruptedStream = await scheduledStream(
    () =>
      ({
        async *[Symbol.asyncIterator]() {
          attempts++;
          if (attempts === 2) controller.abort();
          yield {
            type: "done",
            reason: "stop",
            message: response(attempts === 1 ? "" : "Late response must not commit"),
          };
        },
      }) as any,
    { queue, validate, signal: controller.signal },
  )(model, { messages: [] });
  const interrupted = await interruptedStream.result();
  expect(interrupted.stopReason).toBe("aborted");
  const before = (
    await k.db.pool.query(
      "select *,lease_until>now() as holds_slot from model_requests where id=$1",
      [queue.request.id],
    )
  ).rows[0];
  expect(before).toMatchObject({
    state: "retry_wait",
    reason: "MODEL_INTERRUPTED",
    owner: null,
    attempts: 2,
    validation_failures: 1,
    holds_slot: true,
    finished_at: null,
  });
  expect(before.validation_feedback).toContain("Return a nonempty handoff");
  await k.runs.fail(session.run, new Error("shutdown"), true);
  const resumed = (await k.runs.claim("resumed-worker"))!;
  expect(resumed.id).toBe(session.run.id);
  expect(resumed.epoch).toBe(session.run.epoch + 1);
  const restored = new ModelQueue(k.db, { ...queue.request, runEpoch: resumed.epoch });
  await restored.initialize();
  await k.db.pool.query("update model_quota_groups set capacity=1 where id=$1", [group]);
  expect((await restored.admit(group)).owner).toBeNull();
  const sibling = new ModelQueue(k.db, {
    id: key(),
    conversationId: key(),
    purpose: "conversation",
    endpointId: group,
    endpointKey: group,
    sourceHash: "other",
  });
  await sibling.initialize();
  expect((await sibling.admit(group)).owner).toBeNull();
  await sibling.cancel();
  await k.db.pool.query(
    "update model_requests set lease_until=now()-interval '1 second' where id=$1",
    [queue.request.id],
  );
  let resumedAttempts = 0;
  const rejectedStream = await scheduledStream(
    (_model, context) =>
      ({
        async *[Symbol.asyncIterator]() {
          resumedAttempts++;
          expect(context.messages.at(-1)?.content).toContain("Return a nonempty handoff");
          yield { type: "done", reason: "stop", message: response("") };
        },
      }) as any,
    { queue: restored, validate },
  )(model, { messages: [] });
  const rejected = await rejectedStream.result();
  expect(resumedAttempts).toBe(1);
  expect(rejected.errorMessage).toContain("after one correction");
  const after = (
    await k.db.pool.query("select * from model_requests where id=$1", [queue.request.id])
  ).rows[0];
  expect(after).toMatchObject({ state: "failed", attempts: 3, validation_failures: 2 });
  expect(after.first_failure_at).toEqual(before.first_failure_at);
  expect(
    (
      await k.db.pool.query(
        "select attempt from model_response_validations where request_id=$1 order by attempt",
        [queue.request.id],
      )
    ).rows.map((r) => r.attempt),
  ).toEqual([1, 3]);
});

it("keeps an explicit user cancellation terminal and refuses stale epoch interruption writes", async () => {
  const { session, group, queue } = await activeRequest();
  await queue.initialize();
  const owner = (await queue.admit(group)).owner!;
  await k.db.pool.query("update runs set cancel_requested_at=now() where id=$1", [session.run.id]);
  await queue.cancel(owner);
  expect(
    (
      await k.db.pool.query(
        "select state,reason,lease_until>now() as holds_slot from model_requests where id=$1",
        [queue.request.id],
      )
    ).rows[0],
  ).toEqual({ state: "cancelled", reason: "MODEL_CANCELLED", holds_slot: true });
  await expect(queue.admit(group)).rejects.toMatchObject({ code: "MODEL_RUN_EXPIRED" });

  const fresh = await activeRequest();
  await fresh.queue.initialize();
  const staleOwner = (await fresh.queue.admit(fresh.group)).owner!;
  await k.db.pool.query("update runs set epoch=epoch+1 where id=$1", [fresh.session.run.id]);
  await fresh.queue.cancel(staleOwner);
  expect(
    (
      await k.db.pool.query("select state,owner from model_requests where id=$1", [
        fresh.queue.request.id,
      ])
    ).rows[0],
  ).toEqual({ state: "leased", owner: staleOwner });
});
