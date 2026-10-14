import { expect, it } from "vitest";
import { ModelQueue } from "../../apps/server/dist/modules/model-runtime/queue.js";
import { scheduledStream } from "../../apps/server/dist/modules/model-runtime/stream.js";
import { k, key } from "./helpers/runtime-redesign.js";

async function request() {
  const group = `window-${key()}`;
  const queue = new ModelQueue(k.db, {
    id: key(),
    conversationId: key(),
    purpose: "conversation",
    endpointId: group,
    endpointKey: group,
    sourceHash: "original-request",
  });
  await queue.initialize();
  return { queue, group };
}

async function run(queue: ModelQueue, overload = false) {
  let attempts = 0;
  const message: any = {
    role: "assistant",
    content: [{ type: "text", text: "Verified result" }],
    stopReason: "stop",
  };
  const stream = await scheduledStream(
    () => {
      attempts++;
      return {
        async *[Symbol.asyncIterator]() {
          if (overload && attempts === 1)
            yield { type: "error", reason: "error", error: { errorMessage: "engine_overloaded" } };
          else yield { type: "done", reason: "stop", message };
        },
      } as any;
    },
    { queue, retryWindowMs: 5000 },
  )({ id: "test", provider: "custom", api: "openai-completions" } as any, { messages: [] });
  return { result: await stream.result(), attempts };
}

it("starts the retry window at failure instead of charging ordinary queue age", async () => {
  const { queue } = await request();
  await k.db.pool.query("update model_requests set created_at=now()-interval '1 day' where id=$1", [
    queue.request.id,
  ]);
  const { result, attempts } = await run(queue, true);
  expect(result).toMatchObject({ stopReason: "stop" });
  expect(attempts).toBe(2);
  const stored = (
    await k.db.pool.query("select state,first_failure_at from model_requests where id=$1", [
      queue.request.id,
    ])
  ).rows[0];
  expect(stored).toMatchObject({ state: "succeeded", first_failure_at: expect.any(Date) });
});

it("preserves an excessive shared cooldown without sending an early request", async () => {
  const { queue, group } = await request();
  await k.db.pool.query(
    "update model_quota_groups set cooldown_until=now()+interval '1 hour' where id=$1",
    [group],
  );
  const { result, attempts } = await run(queue);
  expect(attempts).toBe(0);
  expect(result).toMatchObject({
    stopReason: "error",
    errorMessage: expect.stringContaining("MODEL_COOLDOWN"),
  });
  const stored = (
    await k.db.pool.query(
      "select state,attempts,next_attempt_at>now()+interval '59 minutes' as respects_cooldown from model_requests where id=$1",
      [queue.request.id],
    )
  ).rows[0];
  expect(stored).toEqual({ state: "failed", attempts: 0, respects_cooldown: true });
});

it("does not dispatch an already eligible retry after its recovery window expired", async () => {
  const { queue } = await request();
  await k.db.pool.query(
    "update model_requests set state='retry_wait',first_failure_at=now()-interval '1 hour',next_attempt_at=now()-interval '1 minute' where id=$1",
    [queue.request.id],
  );
  const { result, attempts } = await run(queue);
  expect(attempts).toBe(0);
  expect(result).toMatchObject({
    stopReason: "error",
    errorMessage: expect.stringContaining("MODEL_COOLDOWN"),
  });
});
