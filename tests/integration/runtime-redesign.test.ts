import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCanvasAgent } from "../../apps/server/dist/adapters/model/agent.js";
import { summaryMessage } from "../../apps/server/dist/modules/context/messages.js";
import { invokeTool } from "../../apps/server/dist/modules/execution/tool-calls.js";
import { completionState } from "../../apps/server/dist/modules/work/progress/completion.js";
import { hasReviewedAnswer } from "../../apps/server/dist/modules/work/progress/deliveries.js";
import { progressExecutionState } from "../../apps/server/dist/modules/work/progress/execution-state.js";
import {
  instructionSources,
  withOriginalInstructions,
} from "../../apps/server/dist/modules/work/progress/sources.js";
import { agent, board, consume, k, key, start } from "./helpers/runtime-redesign.js";

it("uses only flat current tools and rejects obsolete calls before effects", async () => {
  const s = await start((await agent()).id);
  for (const name of ["review_inbox", "wait_for_message", "report_result"]) {
    const out = await s.call(name, {});
    expect(out.value.call).toMatchObject({ state: "rejected", phase: "validate", effect: "none" });
    expect(out.value.error.code).toBe("UNKNOWN_TOOL");
  }
  expect(
    (await s.call("read", { target: { kind: "path", path: "/tmp/private" } })).value.call.effect,
  ).toBe("none");
  const out = await invokeTool(
    s.ctx,
    s.tools.find((t) => t.name === "send_message")!,
    key(),
    { to: "user", message: "must not send" },
    undefined,
    undefined,
    5,
  );
  expect(JSON.stringify(out.result)).toContain("TOOL_CONTRACT_REPLACED");
  expect(
    (
      await k.db.pool.query(
        "select 1 from messages where conversation_id=$1 and content->>'text'='must not send'",
        [s.run.subject_id],
      )
    ).rowCount,
  ).toBe(0);
});

it("checks real work before completion and keeps unaffected background dispositions", async () => {
  const a = await agent(),
    b = await agent(),
    s = await start(a.id),
    recipient = await start(b.id);
  await consume(s);
  const delivery = (
    await s.call("send_message", { to: "agent", id: b.id, message: "optional info" })
  ).value.deliveries[0].id;
  expect(
    (await s.call("review_progress", { outcome: "completed", reason: "delivered" })).value.error
      .code,
  ).toBe("PROGRESS_OBLIGATIONS");
  const inbox = (await s.call("read_inbox", {})).value;
  expect(inbox.items).toHaveLength(1);
  await s.call("update_message", {
    delivery_id: inbox.items[0].ref,
    action: "background",
    reason: "Information only; current deliverable is ready",
  });
  expect(
    (
      await s.call("review_progress", {
        outcome: "completed",
        reason: "Requested deliverable and verification are provided",
      })
    ).value.reviewed,
  ).toBe(true);
  await consume(recipient);
  expect((await completionState(k.db.pool, s.run.subject_id, s.run.id)).kind).toBe("ready");
  await k.db.canvas(board, (tx) =>
    k.conversations.append(
      tx,
      s.run.subject_id,
      key(),
      "user",
      { text: "additional requirement" },
      s.run.id,
    ),
  );
  expect((await completionState(k.db.pool, s.run.subject_id, s.run.id)).kind).toBe("review");
  expect((await s.call("read_inbox", {})).value.items.some((i: any) => i.id === delivery)).toBe(
    false,
  );
});

it("waits directly for actual pending replies and refuses fictional dependencies", async () => {
  const a = await agent(),
    b = await agent(),
    s = await start(a.id);
  await consume(s);
  expect(
    (
      await s.call("review_progress", {
        outcome: "waiting",
        reason: "Await something",
        remaining_work: "deliver",
        dependency_ids: ["invented"],
      })
    ).value.error.code,
  ).toBe("PROGRESS_DEPENDENCY");
  const request = (
    await s.call("send_message", {
      to: "agent",
      id: b.id,
      message: "Please verify",
      expectReply: true,
    })
  ).value.deliveries[0].id;
  const waiting = await s.call("review_progress", {
    outcome: "waiting",
    reason: "Await requested verification",
    remaining_work: "Deliver validated result",
    dependency_ids: [request],
  });
  expect(waiting.waiting).toBe("message");
  expect(waiting.value).not.toHaveProperty("reviewToken");
});

it("requires a fresh answer when approval completes during generation of a waiting reply", async () => {
  const s = await start((await agent()).id);
  await consume(s);
  const pending = await s.call("request_permission", {
    scope: { kind: "role", role: "admin" },
    reason: "Need authority for the requested work",
  });
  expect(pending.waiting).toBe("approval");
  const basis = async () => ({
    executionHash: (await progressExecutionState(k.db.pool, s.run.id)).hash,
    consumedInputSeq: (
      await k.db.pool.query("select consumed_message_seq from conversations where id=$1", [
        s.run.subject_id,
      ])
    ).rows[0].consumed_message_seq,
  });
  const answer = (text: string, reviewBasis: Awaited<ReturnType<typeof basis>>) =>
    k.db.canvas(board, (tx) =>
      k.conversations.append(
        tx,
        s.run.subject_id,
        key(),
        "assistant",
        { text, stopReason: "stop", reviewBasis },
        s.run.id,
      ),
    );
  const pendingBasis = await basis();
  const request = (
    await k.db.pool.query("select id,version from approvals where id=$1", [pending.value.requestId])
  ).rows[0];
  await k.access.decide(request.id, request.version, "approve", "Approved for the test");
  // The answer arrives after approval, but was generated using the pending receipt.
  await answer("Still awaiting permission", pendingBasis);
  await consume(s);
  expect(
    (await s.call("review_progress", { outcome: "completed", reason: "The request is resolved" }))
      .value.reviewed,
  ).toBe(true);
  expect(await hasReviewedAnswer(k.db.pool, s.run.subject_id, s.run.id)).toBe(false);
  await answer("Permission granted; requested work verified", await basis());
  expect(await hasReviewedAnswer(k.db.pool, s.run.subject_id, s.run.id)).toBe(true);
});

it("does not turn ordinary unread/reply reminders into urgent interrupts", async () => {
  const a = await agent(),
    b = await agent(),
    s = await start(a.id);
  await consume(s);
  const delivery = (
    await s.call("send_message", { to: "agent", id: b.id, message: "verify", expectReply: true })
  ).value.deliveries[0].id;
  await k.db.pool.query(
    "update message_deliveries set deadline_at=now()-interval '1 minute',unread_deadline_at=now()-interval '1 minute' where id=$1",
    [delivery],
  );
  await k.tools.messages.tick();
  await k.tools.messages.tick();
  const rows = (
    await k.db.pool.query(
      "select * from messages where conversation_id=$1 and role='message_notice'",
      [s.run.subject_id],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].expedite_run_id).toBeNull();
  expect(rows[0].content.priority).toBeUndefined();
});

it("restores original instructions independently of misleading summaries and conversation order", async () => {
  const a = await start((await agent()).id),
    b = await start((await agent()).id);
  await k.db.canvas(board, async (tx) => {
    await k.conversations.append(
      tx,
      a.run.subject_id,
      key(),
      "user",
      { text: "Complete reading the entire Orbiverse project" },
      a.run.id,
    );
    await k.conversations.append(
      tx,
      b.run.subject_id,
      key(),
      "user",
      { text: "Unrelated B-only requirement" },
      b.run.id,
    );
  });
  await consume(a);
  await consume(b);
  const ca = (await k.db.pool.query("select * from conversations where id=$1", [a.run.subject_id]))
    .rows[0];
  const originals = await instructionSources(k.db.pool, a.run.subject_id, ca.consumed_message_seq);
  const model = createCanvasAgent(
    { kind: "mock", streamDelayMs: 0, supportsVision: false },
    "test",
  );
  const bogus = summaryMessage(
    model.state.model,
    "summary-test",
    { text: "I will summarize only and stop reading" },
    "en",
  );
  const restored = withOriginalInstructions([bogus, bogus], originals, "en");
  expect(JSON.stringify(restored)).toContain("Complete reading the entire Orbiverse project");
  expect(JSON.stringify(restored)).not.toContain("B-only");
  expect(restored.filter((m: any) => m.intrica?.kind === "summary")).toHaveLength(1);
  expect(restored.find((m: any) => m.intrica?.kind === "summary")?.role).toBe("assistant");
});

it("reads large UTF-8 files completely with scoped cursors, long lines and version checks", async () => {
  const a = await agent(),
    s = await start(a.id),
    other = await start((await agent()).id);
  const path = join(await k.host.workspace(board, a.id), "large.json");
  const original = `\uFEFF${"a".repeat(32765)}\uFEFF${"汉字🙂".repeat(130000)}\nlast line\n`;
  await writeFile(path, original);
  let page = (await s.call("read", { path, mode: "text" })).value;
  expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(32768);
  const firstCursor = page.nextCursor;
  expect((await other.call("read_next", { cursor: firstCursor })).value.error.code).toBe(
    "READ_CURSOR_EXPIRED",
  );
  expect((await s.call("read", { path, cursor: firstCursor })).value.error.code).toBe(
    "TOOL_ARGUMENTS",
  );
  let content = page.text;
  while (page.nextCursor) {
    page = (await s.call("read_next", { cursor: page.nextCursor })).value;
    expect(page.error).toBeUndefined();
    content += page.text;
  }
  expect(content).toBe(original);
  await writeFile(path, "changed");
  expect((await s.call("read_next", { cursor: firstCursor })).value.error.code).toBe(
    "SOURCE_CHANGED",
  );
});

it("returns positioning instead of false EOF and accepts directory auto/text", async () => {
  const a = await agent(),
    s = await start(a.id),
    workspace = await k.host.workspace(board, a.id);
  const path = join(workspace, "seek.txt");
  await writeFile(path, `${"x".repeat(1048577)}\nTARGET\n`);
  const first = (await s.call("read", { path, line: 2 })).value;
  expect(first).toMatchObject({ state: "positioning", text: "", nextCursor: expect.any(String) });
  expect((await s.call("read_next", { cursor: first.nextCursor })).value.text).toBe("TARGET\n");
  expect(
    (await s.call("read", { path: workspace, mode: "text" })).value.entries.length,
  ).toBeGreaterThan(0);
  expect((await s.call("read", { path: workspace, line: 1 })).result.isError).toBe(true);
});
