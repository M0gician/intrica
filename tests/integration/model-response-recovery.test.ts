import { expect, it } from "vitest";
import { createCanvasAgent } from "../../apps/server/dist/adapters/model/agent.js";
import { withModelUsage } from "../../apps/server/dist/adapters/model/usage.js";
import { validateContextSummary as validate } from "../../apps/server/dist/modules/context/summary-contract.js";
import { ModelQueue } from "../../apps/server/dist/modules/model-runtime/queue.js";
import {
  ResponseValidationError,
  validationReceipt,
} from "../../apps/server/dist/modules/model-runtime/response-validation.js";
import { conversationTrace } from "../../apps/server/dist/modules/work/trace.js";
import { agent, k, key, start } from "./helpers/runtime-redesign.js";

const config = {
  kind: "pi" as const,
  provider: "custom",
  modelId: "recovery-fixture",
  api: "openai-completions" as const,
  baseUrl: "http://unused.invalid",
  thinkingLevel: "off" as const,
};
const source = "Frozen evidence: requirement R1; result E1; outstanding responsibility U1.";
const valid =
  "Requirement R1 remains active. Evidence E1 was verified. Responsibility U1 is pending.";
const response = (text = valid, stopReason = "stop") =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
    timestamp: 0,
    api: config.api,
    provider: config.provider,
    model: config.modelId,
    usage: {
      input: 20,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }) as any;
const textOf = (message: any) =>
  message.content
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text)
    .join("\n");

async function execute(
  provider: (context: any, attempt: number, options: any) => any,
  extra: Record<string, unknown> = {},
) {
  const conversationId = key();
  const contexts: any[] = [];
  const events: any[] = [];
  const identity = {
    db: k.db,
    purpose: "compaction",
    model: { config },
    conversationId,
    requestId: key(),
    validateResponse: validate,
    ...extra,
  };
  const model = createCanvasAgent(config, (_model, context, options) => {
    contexts.push(structuredClone(context));
    return {
      async *[Symbol.asyncIterator]() {
        const result = await provider(context, contexts.length, options);
        if (result.errorMessage) {
          yield { type: "error", reason: "error", error: { ...response(), ...result } };
          return;
        }
        yield { type: "start", partial: result };
        yield { type: "done", reason: result.stopReason, message: result };
      },
    } as any;
  });
  model.state.messages.push({ role: "user", content: source, timestamp: 0 });
  const result = await withModelUsage(identity, () =>
    model.turn(undefined, async (event) => {
      events.push(event);
    }),
  ).then(
    (value) => ({ value, error: undefined }),
    (error: Error) => ({ value: undefined, error }),
  );
  const request = (
    await k.db.pool.query("select * from model_requests where conversation_id=$1", [
      identity.conversationId,
    ])
  ).rows[0];
  const receipts = (
    await k.db.pool.query(
      "select * from model_response_validations where request_id=$1 order by attempt",
      [request.id],
    )
  ).rows;
  const calls = (
    await k.db.pool.query(
      "select outcome from model_calls where request_id=$1 order by started_at",
      [request.id],
    )
  ).rows;
  return { ...result, request, receipts, contexts, events, calls };
}

const faults = [
  ["summary_empty", response("")],
  ["summary_too_long", response("x".repeat(24001))],
  ["output_truncated", response("Requirement R1", "length")],
  [
    "summary_tool_call",
    {
      ...response(),
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "must-not-run",
          name: "bash",
          arguments: { command: "touch should-not-exist" },
        },
      ],
    },
  ],
] as const;

it.each(faults)(
  "repairs %s once with feedback, preserving evidence and auditing both responses",
  async (issue, invalid) => {
    const run = await execute((context) => (context.messages.length === 1 ? invalid : response()));
    expect(run.error).toBeUndefined();
    expect(textOf(run.value)).toContain("U1");
    expect(run.contexts).toHaveLength(2);
    expect(run.contexts[0].messages).toEqual([{ role: "user", content: source, timestamp: 0 }]);
    expect(run.contexts[1].messages.slice(0, 1)).toEqual(run.contexts[0].messages);
    expect(run.contexts[1].messages[1].content).toContain("rejected by service validation");
    expect(JSON.stringify(run.contexts[1])).not.toContain("must-not-run");
    expect(run.events).toEqual([]);
    expect(run.request).toMatchObject({ state: "succeeded", attempts: 2, validation_failures: 1 });
    expect(run.receipts.map((r: any) => [r.status, r.issue])).toEqual([
      ["rejected", issue],
      ["accepted", null],
    ]);
    expect(run.receipts[0].output_hash).toBe(validationReceipt(invalid).outputHash);
    expect(run.receipts[0].output_excerpt.length).toBeLessThanOrEqual(16000);
    expect(run.receipts[0].output_truncated).toBe(issue === "summary_too_long");
    expect(run.calls.map((c: any) => c.outcome)).toEqual(["succeeded", "succeeded"]);
  },
);

it("stops after one unsuccessful correction and never exposes unaccepted text", async () => {
  const run = await execute(() => response(""));
  expect(run.contexts).toHaveLength(2);
  expect(run.request).toMatchObject({ state: "failed", validation_failures: 2 });
  expect(run.error?.message).toContain("after one correction");
  expect(run.receipts.map((r: any) => r.status)).toEqual(["rejected", "rejected"]);
  expect(run.events).toEqual([]);
});

it("exposes validation metadata in traces while keeping raw response excerpts private", async () => {
  const active = await start((await agent()).id);
  const run = await execute(() => response("PRIVATE_HANDOFF_DETAILS"), {
    runId: active.run.id,
    runEpoch: active.run.epoch,
    conversationId: active.run.subject_id,
  });
  expect(run.error).toBeUndefined();
  const trace = await conversationTrace(k.db, active.run.subject_id);
  expect(trace.modelValidations).toHaveLength(1);
  expect(trace.modelValidations[0]).toMatchObject({
    status: "accepted",
    output_hash: run.receipts[0].output_hash,
  });
  expect(JSON.stringify(trace)).not.toContain("PRIVATE_HANDOFF_DETAILS");
  expect(JSON.stringify(trace)).not.toContain("output_excerpt");
});

it("keeps network retry ownership and the correction budget separate", async () => {
  const run = await execute((_context, attempt) =>
    attempt === 1
      ? response("")
      : attempt === 2
        ? { errorMessage: "engine_overloaded" }
        : response(),
  );
  expect(run.error).toBeUndefined();
  expect(run.contexts).toHaveLength(3);
  expect(run.contexts[2]).toEqual(run.contexts[1]);
  expect(run.request).toMatchObject({ state: "succeeded", attempts: 3, validation_failures: 1 });
  expect(run.receipts.map((r: any) => r.attempt)).toEqual([1, 3]);
  expect(run.calls.map((c: any) => c.outcome)).toEqual(["succeeded", "error", "succeeded"]);
});

it("preserves the consumed correction budget across scheduler reconstruction", async () => {
  const group = key();
  const queue = new ModelQueue(k.db, {
    id: key(),
    conversationId: key(),
    purpose: "compaction",
    endpointId: group,
    endpointKey: group,
    sourceHash: "frozen",
  });
  await queue.initialize();
  const owner = (await queue.admit(group)).owner!;
  await queue.validate(
    owner,
    1,
    validationReceipt(response(""), new ResponseValidationError("empty")),
    "Return a nonempty handoff.",
  );
  await k.db.pool.query(
    "update model_requests set lease_until=now()-interval '1 second' where id=$1",
    [queue.request.id],
  );
  const { scheduledStream } = await import(
    "../../apps/server/dist/modules/model-runtime/stream.js"
  );
  let attempts = 0;
  const restored = new ModelQueue(k.db, queue.request);
  const result = await (
    await scheduledStream(
      (_model, context) => {
        attempts++;
        expect(context.messages.at(-1)?.content).toContain("Return a nonempty handoff");
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "done", reason: "stop", message: response("") };
          },
        } as any;
      },
      { queue: restored, validate },
    )({ id: "test", provider: "custom", api: "openai-completions" } as any, { messages: [] })
  ).result();
  expect(attempts).toBe(1);
  expect(result.errorMessage).toContain("after one correction");
  expect(
    (
      await k.db.pool.query("select validation_failures from model_requests where id=$1", [
        queue.request.id,
      ])
    ).rows[0].validation_failures,
  ).toBe(2);
});

it("rejects obsolete validation and retry writes after a run changes epoch", async () => {
  const active = await start((await agent()).id);
  const group = key();
  const queue = new ModelQueue(k.db, {
    id: key(),
    runId: active.run.id,
    runEpoch: active.run.epoch,
    conversationId: active.run.subject_id,
    purpose: "compaction",
    endpointId: group,
    endpointKey: group,
    sourceHash: "frozen",
  });
  await queue.initialize();
  const owner = (await queue.admit(group)).owner!;
  await k.db.pool.query("update runs set epoch=epoch+1 where id=$1", [active.run.id]);
  await expect(queue.validate(owner, 1, validationReceipt(response()), null)).rejects.toMatchObject(
    { code: "MODEL_LEASE_LOST" },
  );
  await expect(
    queue.retry(
      owner,
      { code: "CONTEXT_SUMMARY_INVALID", retryable: false, shared: false, message: "invalid" },
      0,
      true,
      false,
    ),
  ).rejects.toMatchObject({ code: "MODEL_LEASE_LOST" });
  expect(
    (
      await k.db.pool.query(
        "select count(*)::int as n from model_response_validations where request_id=$1",
        [queue.request.id],
      )
    ).rows[0].n,
  ).toBe(0);
});

it("cancels during correction without accepting or dispatching another response", async () => {
  const { scheduledStream } = await import(
    "../../apps/server/dist/modules/model-runtime/stream.js"
  );
  const group = key();
  const queue = new ModelQueue(k.db, {
    id: key(),
    conversationId: key(),
    purpose: "compaction",
    endpointId: group,
    endpointKey: group,
    sourceHash: "frozen",
  });
  const signal = new AbortController();
  let attempts = 0;
  const result = await (
    await scheduledStream(
      () =>
        ({
          async *[Symbol.asyncIterator]() {
            attempts++;
            if (attempts === 2) signal.abort();
            yield {
              type: "done",
              reason: "stop",
              message: attempts === 1 ? response("") : response(),
            };
          },
        }) as any,
      { queue, validate, signal: signal.signal },
    )({ id: "test", provider: "custom", api: "openai-completions" } as any, { messages: [] })
  ).result();
  expect(attempts).toBe(2);
  expect(result.stopReason).toBe("aborted");
  expect(
    (await k.db.pool.query("select state from model_requests where id=$1", [queue.request.id]))
      .rows[0].state,
  ).toBe("cancelled");
  expect(
    (
      await k.db.pool.query(
        "select count(*)::int as n from model_response_validations where request_id=$1",
        [queue.request.id],
      )
    ).rows[0].n,
  ).toBe(1);
});
