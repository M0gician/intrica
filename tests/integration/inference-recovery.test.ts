import { expect, it } from "vitest";
import { createCanvasAgent } from "../../apps/server/dist/adapters/model/agent.js";
import {
  continuationCapabilities,
  PiEvents,
} from "../../apps/server/dist/adapters/model/pi-events.js";
import { withModelUsage } from "../../apps/server/dist/adapters/model/usage.js";
import { contextManifest } from "../../apps/server/dist/modules/inference/context-projection.js";
import { ItemStore } from "../../apps/server/dist/modules/inference/item-store.js";
import {
  beginSettling,
  claimDispatch,
  openAttempt,
} from "../../apps/server/dist/modules/inference/lifecycle.js";
import { saveCheckpoint } from "../../apps/server/dist/modules/work/checkpoints.js";
import { appendContextInput } from "../../apps/server/dist/modules/work/context-builder.js";
import { expediteInput } from "../../apps/server/dist/modules/work/input-receipts.js";
import { addressedOutput } from "../fixtures/addressed-output.mjs";
import { reasoning } from "../fixtures/inference-wire.js";
import { inferenceHarness, key } from "./helpers/inference.js";

type AssistantMessage = Awaited<ReturnType<ReturnType<typeof createCanvasAgent>["turn"]>>;
const h = inferenceHarness();

it.each(["prepared", "streaming", "cutting", "settling", "sealed"])(
  "restart from %s reuses committed native history and rejects the former lease",
  async (state) => {
    const s = await h.session();
    const input = s.run.frozen_input;
    input.generation = 0;
    const config = await h.k.models.materialize(input.model);
    const model = createCanvasAgent(config, s.run.id);
    const received = (
      await h.k.db.pool.query("select * from messages where conversation_id=$1 order by seq", [
        s.conversationId,
      ])
    ).rows;
    const consumedInContext = new Set<string>();
    const consumed = await appendContextInput(
      h.k.conversations,
      input,
      model,
      received,
      "0",
      consumedInContext,
    );
    let requestId = key();
    const persist = (tx: any) =>
      saveCheckpoint(
        tx,
        s.ctx,
        input,
        model,
        config,
        consumed,
        consumedInContext,
        0,
        requestId,
        2,
        1,
        false,
        { pendingOutput: null, messageRepairAttempts: 0, messageProtocolBlocked: false },
      );
    await h.k.db.canvas(s.canvasId, persist);
    const identity = await openAttempt(
      s.ctx,
      {
        conversationId: s.conversationId,
        runId: s.run.id,
        requestId,
        workItemId: input.workItemId,
        leaseEpoch: s.run.epoch,
        decisionRevision: 0,
      },
      continuationCapabilities(model.state.model.api),
      contextManifest(model.state.messages),
    );
    await claimDispatch(s.ctx, identity);
    const store = new ItemStore(s.ctx, identity);
    const native = { ...reasoning("rs_saved", "encrypted_saved"), status: "completed" };
    const text = JSON.stringify({ target: { kind: "internal" }, message: "Saved work" });
    const complete: AssistantMessage = {
      role: "assistant",
      api: model.state.model.api,
      provider: model.state.model.provider,
      model: model.state.model.id,
      content: [
        {
          type: "thinking",
          thinking: "Saved reasoning",
          thinkingSignature: JSON.stringify(native),
          nativeItem: native,
        },
        {
          type: "text",
          text,
          nativeItem: {
            type: "message",
            id: "msg_saved",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        },
      ],
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    for (const event of new PiEvents(model.state.model).events({
      type: "done",
      reason: "stop",
      message: complete,
    })) {
      if (event.type === "item.closed") await store.observe(event.index, event.block, "closed");
      if (event.type === "item.continuation_ready") await store.commit(event, model, persist);
    }
    await store.seal("completed");
    requestId = key();
    const active = await openAttempt(
      s.ctx,
      { ...identity, requestId },
      continuationCapabilities(model.state.model.api),
      contextManifest(model.state.messages),
    );
    const interrupted = new ItemStore(s.ctx, active);
    if (state !== "prepared") {
      await claimDispatch(s.ctx, active);
      await interrupted.observe(0, { type: "thinking", thinking: "VOLATILE_DRAFT_B" }, "streaming");
    }
    if (state === "cutting" || state === "settling") {
      const inputId = key();
      await h.k.conversations.submit({
        canvasId: s.canvasId,
        conversationId: s.conversationId,
        message: "An input accepted before restart",
        key: inputId,
        association: { kind: "append", requestId: input.workItemId },
      });
      await expediteInput(h.k.db, s.conversationId, inputId);
      if (state === "settling") await beginSettling(s.ctx, active, 1000);
    }
    if (state === "sealed") await interrupted.seal("retry", false);
    await h.k.db.pool.query(
      "update runs set lease_until=clock_timestamp()-interval '1 second' where id=$1",
      [s.run.id],
    );
    await h.k.runs.recover();
    const run = (await h.k.runs.claim("restarted-inference"))!;
    expect(run.id).toBe(s.run.id);
    expect(run.epoch).toBeGreaterThan(s.run.epoch);
    await expect(
      interrupted.observe(0, { type: "text", text: "LATE_OLD_LEASE" }, "closed"),
    ).rejects.toMatchObject({ code: "STALE_EXECUTION" });
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
    expect(JSON.stringify(next.body)).toContain("encrypted_saved");
    expect(JSON.stringify(next.body)).not.toMatch(/VOLATILE_DRAFT_B|LATE_OLD_LEASE/);
    next.start();
    next.answer(addressedOutput(JSON.stringify(next.body), "Recovery complete"));
    await resumed;
    const rows = (
      await h.k.db.pool.query(
        "select a.state from inference_attempts a join inference_requests q on q.id=a.request_id where q.run_id=$1",
        [run.id],
      )
    ).rows;
    expect(rows.every((r) => r.state === "sealed")).toBe(true);
    expect(
      (
        await h.k.db.pool.query("select state from inference_items where attempt_id=$1", [
          active.attemptId,
        ])
      ).rows.every((r) => r.state === "discarded"),
    ).toBe(true);
  },
);
