import { expect, it } from "vitest";
import { withModelUsage } from "../../apps/server/dist/adapters/model/usage.js";
import { summarizeContext } from "../../apps/server/dist/modules/context/summary.js";
import { pauseContextFailure } from "../../apps/server/dist/modules/work/conversation-runtime/context-blocked.js";
import { workingState } from "../../apps/server/dist/modules/work/conversation-runtime/working-state.js";
import { agent, board, consume, k, key, start } from "./helpers/runtime-redesign.js";

it("rebuilds current responsibilities independently of stale summaries", async () => {
  const sender = await agent(),
    receiver = await agent();
  const session = await start(sender.id);
  await session.call("send_message", {
    to: "agent",
    id: receiver.id,
    message: "Verify result E-42 and reply",
    expectReply: true,
  });
  const before = await workingState(k.db.pool, session.run.subject_id, "en");
  expect(before).toContain("E-42");
  expect(before).toContain('"total":1');
  // A generated checkpoint cannot settle the independent delivery record.
  await k.db.pool.query("update conversations set checkpoint=$2 where id=$1", [
    session.run.subject_id,
    JSON.stringify([
      { role: "assistant", content: [{ type: "text", text: "All responsibilities complete" }] },
    ]),
  ]);
  expect(await workingState(k.db.pool, session.run.subject_id, "en")).toContain("E-42");
  await k.db.pool.query(
    "update message_deliveries set state='replied',version=version+1 where sender_conversation_id=$1",
    [session.run.subject_id],
  );
  expect(await workingState(k.db.pool, session.run.subject_id, "en")).not.toContain("E-42");
});

it("pauses without changing the checkpoint; only explicit continuation creates new inference admission", async () => {
  const member = await agent();
  const session = await start(member.id);
  await consume(session);
  const checkpoint = [{ role: "user", content: "Preserve the original task", timestamp: 0 }];
  await k.db.pool.query("update conversations set checkpoint=$2 where id=$1", [
    session.run.subject_id,
    JSON.stringify(checkpoint),
  ]);
  await pauseContextFailure(session.ctx, new Error("CONTEXT_SUMMARY_INVALID: summary_empty"), "en");
  expect(await k.runs.get(session.run.id)).toMatchObject({
    state: "waiting",
    reason: "context_blocked",
  });
  const automatic = await k.db.canvas(board, (tx) =>
    k.runs.enqueue(tx, {
      canvasId: board,
      subjectId: session.run.subject_id,
      kind: "conversation",
      frozen: session.run.frozen_input,
      userInitiated: false,
      causeId: session.run.id,
    }),
  );
  expect(automatic).toMatchObject({
    id: session.run.id,
    state: "waiting",
    reason: "context_blocked",
  });
  const next = await k.conversations.submit({
    canvasId: board,
    agentId: member.id,
    message: "Continue after reviewing the failure",
    key: key(),
    resumeRunId: session.run.id,
  });
  expect(next.run.id).not.toBe(session.run.id);
  expect(next.run.state).toBe("queued");
  expect(await k.runs.get(session.run.id)).toMatchObject({
    state: "cancelled",
    reason: "context_retry",
  });
  expect(
    (
      await k.db.pool.query("select checkpoint from conversations where id=$1", [
        session.run.subject_id,
      ])
    ).rows[0].checkpoint,
  ).toEqual(checkpoint);
});

it("uses stable summary IDs, source refs and request identities across a resumed attempt", async () => {
  const session = await start((await agent()).id);
  const config = { kind: "mock", streamDelayMs: 0, supportsVision: false } as const;
  const history = [
    { role: "user" as const, content: "Archived evidence ".repeat(4000), timestamp: 1 },
  ];
  const scope = {
    db: k.db,
    model: session.run.frozen_input.model,
    runId: session.run.id,
    purpose: "conversation",
    conversationId: session.run.subject_id,
  };
  const first = await withModelUsage(scope, () => summarizeContext(config, history));
  const resumed = await withModelUsage({ ...scope, attemptId: "another-worker" }, () =>
    summarizeContext(config, history),
  );
  expect(resumed.id).toBe(first.id);
  expect(resumed.requestId).toBe(first.requestId);
  expect(resumed.sources).toEqual(first.sources);
  const anotherRun = await withModelUsage({ ...scope, runId: key() }, () =>
    summarizeContext(config, history),
  );
  expect(anotherRun.requestId).not.toBe(first.requestId);
});

it("seals interrupted background effects as unknown before retiring the run", async () => {
  const { BackgroundTools } = await import(
    "../../apps/server/dist/modules/execution/background-tools.js"
  );
  const { result } = await import("../../apps/server/dist/modules/execution/tool-calls.js");
  const member = await agent();
  const session = await start(member.id);
  await consume(session);
  const store = Object.assign(Object.create(k.runs), {
    limits: { ...k.runs.limits, toolAsyncAfterMs: 5 },
  });
  let executed = 0;
  const tools = [
    {
      name: "slow_effect",
      label: "slow effect",
      description: "test",
      effect: "external" as const,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_id: string, _args: unknown, signal: AbortSignal) => {
        executed++;
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("interrupted")), { once: true }),
        );
        return result({ done: true });
      },
    },
  ];
  const background = new BackgroundTools(
    { ...session.ctx, store },
    tools,
    async () => {},
    async () => {},
  );
  const receipt = await background.invoke(tools[0]!, key(), {});
  const callId = JSON.parse((receipt.result.content[0] as { text: string }).text).callId;
  await pauseContextFailure(
    session.ctx,
    new Error("CONTEXT_SUMMARY_INVALID: summary_empty"),
    "en",
    () => background.close(),
  );
  expect(
    (await k.db.pool.query("select state,delivered_at from tool_calls where id=$1", [callId]))
      .rows[0],
  ).toMatchObject({ state: "unknown", delivered_at: expect.any(Date) });
  expect((await k.runs.conversationBarrier(session.run.subject_id)).unknown).toBe(true);
  const blocked = await k.conversations.submit({
    canvasId: board,
    agentId: member.id,
    key: key(),
    message: "Continue",
  });
  expect(blocked.run.id).toBe(session.run.id);
  expect(blocked.run.state).toBe("waiting");
  expect(executed).toBe(1);
  await k.conversations.resolveUnknown(
    callId,
    "abandon",
    "Verified no further work is needed from this call",
  );
  const continued = await k.conversations.submit({
    canvasId: board,
    agentId: member.id,
    key: key(),
    message: "Continue after verification",
  });
  expect(continued.run.id).not.toBe(session.run.id);
  expect(executed).toBe(1);
});
