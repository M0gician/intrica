import { expect, it } from "vitest";
import { notifyReviewer } from "../../apps/server/dist/modules/access/lifecycle.js";
import { appendMessage } from "../../apps/server/dist/modules/execution/messages.js";
import { addressedOutput } from "../fixtures/addressed-output.mjs";
import { call, reasoning } from "../fixtures/inference-wire.js";
import { inferenceHarness, key } from "./helpers/inference.js";

const h = inferenceHarness();

it("automatic cutovers reserve a work window while ordinary context boundaries stay available", async () => {
  const s = await h.session();
  await h.k.db.pool.query(
    'update messages set consumed_run_id=$2,expedite_requested_at=clock_timestamp(),content=content||\'{"steeringReason":"inbox"}\' where conversation_id=$1 and client_message_id=$3',
    [s.conversationId, s.run.id, s.inputId],
  );
  const inputId = key();
  await h.k.conversations.submit({
    canvasId: s.canvasId,
    conversationId: s.conversationId,
    key: inputId,
    message: "Next observation",
    association: { kind: "append", requestId: s.run.frozen_input.workItemId },
  });
  await h.k.db.pool.query(
    "update messages set created_at=now()-interval '1 minute' where conversation_id=$1 and client_message_id=$2",
    [s.conversationId, inputId],
  );
  const { steerableInbox } = await import(
    "../../apps/server/dist/modules/inference/inbox-steering.js"
  );
  expect(await steerableInbox(h.k.db.pool, s.conversationId)).toBeUndefined();
  await h.k.db.pool.query(
    "update messages set expedite_requested_at=now()-interval '1 minute' where conversation_id=$1 and client_message_id=$2",
    [s.conversationId, s.inputId],
  );
  expect(await steerableInbox(h.k.db.pool, s.conversationId)).toBe(inputId);
});

it("current approval notices refresh a reviewer while stale notice versions stay inactive", async () => {
  const s = await h.session(undefined, "admin"),
    done = s.execute();
  const first = await h.nextWhile(done);
  first.start();
  first.item(reasoning("reviewer-thinking"), 0, false);
  const id = key();
  const subject = (
    await h.k.graph.createNode({
      kind: "agent",
      parentId: s.run.frozen_input.agentId,
      title: "Member fixture",
      agent: { role: "read", persona: "Check a resource", enabled: false },
      position: { x: 0, y: 0, width: 220, height: 300 },
      idempotencyKey: key(),
    })
  ).node.id;
  await h.k.db.canvas(s.canvasId, async (tx) => {
    const request = (
      await tx.query(
        "insert into approvals(id,canvas_id,subject_id,action,basis,status,assigned_reviewer_id,expires_at,reason) values($1,$2,$4,'{\"kind\":\"resource\"}','{}','pending',$3,now()+interval '1 hour','fixture review') returning *",
        [id, s.canvasId, s.run.frozen_input.agentId, subject],
      )
    ).rows[0];
    await notifyReviewer(tx, { ...request, version: Number(request.version) - 1 });
    const { steerableInbox } = await import(
      "../../apps/server/dist/modules/inference/inbox-steering.js"
    );
    expect(await steerableInbox(tx, s.conversationId, 0)).toBeUndefined();
    await notifyReviewer(tx, request);
  });
  const next = await h.nextWhile(done);
  const payload = JSON.stringify(next.body);
  expect(payload).toContain("permission_review");
  expect(payload).toContain(id);
  next.start();
  next.answer(addressedOutput(payload, "Review notice received"));
  await done;
  const notices = (
    await h.k.db.pool.query(
      "select client_message_id,consumed_at from messages where conversation_id=$1 and role='permission_notice' order by seq",
      [s.conversationId],
    )
  ).rows;
  expect(notices).toHaveLength(2);
  expect(notices[0].consumed_at).toBeNull();
  expect(notices[1].consumed_at).toBeTruthy();
});

it("normal inputs refresh active thinking, coalesce in order and preserve completed tool receipts", async () => {
  const s = await h.session(),
    done = s.execute();
  const first = await h.nextWhile(done);
  first.start();
  first.item(reasoning("rs_committed", "encrypted-committed"), 0);
  first.item(call("checked", "read_canvas"), 1);
  first.item(reasoning("rs_unfinished"), 2, false);
  await h.watch(s.canvasId, () =>
    h.exists("select 1 from tool_calls where run_id=$1 and state='succeeded'", [s.run.id]),
  );
  const inputs = [key(), key()];
  for (let i = 0; i < inputs.length; i++)
    await h.k.conversations.submit({
      canvasId: s.canvasId,
      conversationId: s.conversationId,
      key: inputs[i]!,
      message: `NORMAL_INPUT_${i}`,
      association: { kind: "append", requestId: s.run.frozen_input.workItemId },
    });
  const next = await h.nextWhile(done);
  const payload = JSON.stringify(next.body);
  expect(payload).toContain("encrypted-committed");
  expect(payload).not.toContain("rs_unfinished");
  expect(payload.indexOf("NORMAL_INPUT_0")).toBeLessThan(payload.indexOf("NORMAL_INPUT_1"));
  expect(
    next.body.input.filter(
      (item: any) => item.type === "function_call" && item.call_id === "call_checked",
    ),
  ).toHaveLength(1);
  expect(
    next.body.input.filter(
      (item: any) => item.type === "function_call_output" && item.call_id === "call_checked",
    ),
  ).toHaveLength(1);
  next.start();
  next.answer(addressedOutput(payload, "Handled new context"));
  await done;
  const rows = (
    await h.k.db.pool.query(
      "select content,consumed_at,expedite_requested_at from messages where conversation_id=$1 and client_message_id=any($2::text[]) order by seq",
      [s.conversationId, inputs],
    )
  ).rows;
  expect(rows.every((row: any) => row.consumed_at)).toBe(true);
  expect(rows[0].content.steeringReason).toBe("inbox");
  expect(
    (await h.k.db.pool.query("select id from tool_calls where run_id=$1", [s.run.id])).rows,
  ).toHaveLength(1);
});

it("background progress and outgoing copies leave thinking active; a peer inbox message refreshes it", async () => {
  const s = await h.session(),
    done = s.execute();
  const first = await h.nextWhile(done);
  first.start();
  first.item(reasoning("thinking"), 0, false);
  await h.k.db.canvas(s.canvasId, async (tx) => {
    await appendMessage(
      tx,
      s.conversationId,
      key(),
      "tool_update",
      { progress: true, text: "progress" },
      s.run.id,
    );
    await appendMessage(
      tx,
      s.conversationId,
      key(),
      "message",
      { text: "outgoing copy", recipients: ["someone"] },
      s.run.id,
    );
  });
  // Backdate irrelevant records to exercise eligibility without a timing-only assertion.
  await h.k.db.pool.query(
    "update messages set created_at=now()-interval '1 minute' where conversation_id=$1 and role in('tool_update','message')",
    [s.conversationId],
  );
  const { steerableInbox } = await import(
    "../../apps/server/dist/modules/inference/inbox-steering.js"
  );
  expect(await steerableInbox(h.k.db.pool, s.conversationId)).toBeUndefined();
  const messageId = key();
  await h.k.db.canvas(s.canvasId, (tx) =>
    appendMessage(
      tx,
      s.conversationId,
      messageId,
      "message",
      { from: "peer-fixture", text: "PEER_FINDING", workItemId: s.run.frozen_input.workItemId },
      s.run.id,
    ),
  );
  const next = await h.nextWhile(done);
  expect(JSON.stringify(next.body)).toContain("PEER_FINDING");
  next.start();
  next.answer(addressedOutput(JSON.stringify(next.body), "Peer finding checked"));
  await done;
  expect(
    (
      await h.k.db.pool.query(
        "select consumed_at from messages where conversation_id=$1 and client_message_id=$2",
        [s.conversationId, messageId],
      )
    ).rows[0].consumed_at,
  ).toBeTruthy();
});
