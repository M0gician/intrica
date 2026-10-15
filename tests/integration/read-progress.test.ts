import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { AgentMessage } from "../../apps/server/dist/adapters/model/context.js";
import {
  recentReadObservations,
  recordReadObservations,
} from "../../apps/server/dist/modules/work/evidence/read-observations.js";
import { agent, board, k, key, start } from "./helpers/runtime-redesign.js";

const checkpointResult = (
  response: Awaited<ReturnType<Awaited<ReturnType<typeof start>>["call"]>>,
) =>
  ({
    role: "toolResult",
    toolCallId: response.logical,
    toolName: "read",
    timestamp: 0,
    content: response.result.content,
    details: response.result.details,
    isError: response.result.isError,
  }) as AgentMessage;

it("persists successful returned ranges once and restores the latest source position", async () => {
  const member = await agent(),
    session = await start(member.id);
  const path = join(await k.host.workspace(board, member.id), "reading.txt");
  await writeFile(path, "row\n".repeat(401));
  const first = await session.call("read", { path });
  const record = () =>
    k.db.canvas(board, (tx) =>
      recordReadObservations(tx, session.run.subject_id, [checkpointResult(first)]),
    );
  await record();
  await record();
  expect(
    (
      await k.db.pool.query(
        "select count(*)::int as count from read_observations where conversation_id=$1",
        [session.run.subject_id],
      )
    ).rows[0].count,
  ).toBe(1);
  const next = await session.call("read_next", { cursor: first.value.nextCursor });
  await k.db.canvas(board, (tx) =>
    recordReadObservations(tx, session.run.subject_id, [
      checkpointResult(first),
      checkpointResult(next),
    ]),
  );
  const restored = await recentReadObservations(k.db.pool, session.run.subject_id, 8, k.host);
  expect(restored).toHaveLength(1);
  expect(restored[0]).toMatchObject({
    source: { kind: "path", path },
    sourceVersion: first.value.sourceVersion,
    position: { unit: "lines", line: 201, returnedLines: 200, returnedChars: 800 },
    nextCursor: next.value.nextCursor,
    observation: "tool_returned",
  });
  expect(
    (
      await k.db.pool.query(
        "select count(*)::int as count from read_observations where conversation_id=$1",
        [session.run.subject_id],
      )
    ).rows[0].count,
  ).toBe(2);
});

it("expired cursors expose safe reopening arguments; failed or changed reads cannot create progress", async () => {
  const member = await agent(),
    session = await start(member.id);
  const path = join(await k.host.workspace(board, member.id), "expiring.txt");
  await writeFile(path, "row\n".repeat(401));
  const first = await session.call("read", { path });
  await k.db.canvas(board, (tx) =>
    recordReadObservations(tx, session.run.subject_id, [checkpointResult(first)]),
  );
  await k.db.pool.query(
    "update read_cursors set expires_at=now()-interval '1 second' where id=$1",
    [first.value.nextCursor],
  );
  const expired = await session.call("read_next", { cursor: first.value.nextCursor });
  expect(expired.value.error).toMatchObject({
    code: "READ_CURSOR_EXPIRED",
    reopen: { path, line: 201, sourceVersion: first.value.sourceVersion },
  });
  const state = await recentReadObservations(k.db.pool, session.run.subject_id, 8, k.host);
  expect(state[0]).toMatchObject({
    nextCursor: null,
    reopen: { path, line: 201, sourceVersion: first.value.sourceVersion },
  });
  const reopened = await session.call("read", expired.value.error.reopen);
  expect(reopened.value).toMatchObject({ offset: 201, returnedLines: 200 });
  await writeFile(path, "changed");
  const changed = await session.call("read", expired.value.error.reopen);
  expect(changed.value.error.code).toBe("SOURCE_CHANGED");
  await k.db.canvas(board, (tx) =>
    recordReadObservations(tx, session.run.subject_id, [
      checkpointResult(expired),
      checkpointResult(changed),
    ]),
  );
  expect(
    (
      await k.db.pool.query(
        "select count(*)::int as count from read_observations where conversation_id=$1",
        [session.run.subject_id],
      )
    ).rows[0].count,
  ).toBe(1);
});

it("ordinary text nodes reopen at the actual character boundary after a cursor expires", async () => {
  const member = await agent(),
    session = await start(member.id);
  const body = "汉字abcdef".repeat(1500);
  const created = await session.call("create_artifact", {
    kind: "text",
    title: "Reading fixture",
    text: body,
    shareWithManagers: false,
  });
  const first = await session.call("read", { nodeId: created.value.id });
  await k.db.pool.query(
    "update read_cursors set expires_at=now()-interval '1 second' where id=$1",
    [first.value.nextCursor],
  );
  const expired = await session.call("read_next", { cursor: first.value.nextCursor });
  expect(expired.value.error.reopen).toMatchObject({
    nodeId: created.value.id,
    characterOffset: 6000,
    sourceVersion: first.value.sourceVersion,
  });
  const reopened = await session.call("read", expired.value.error.reopen);
  expect(reopened.result.isError).not.toBe(true);
  expect(first.value.content + reopened.value.content).toBe(body);
});

it("published text attachments reopen at the actual line boundary, not a character offset", async () => {
  const member = await agent(),
    session = await start(member.id);
  const path = join(await k.host.workspace(board, member.id), "published-lines.txt");
  await writeFile(path, "line\n".repeat(401));
  const created = await session.call("create_artifact", {
    kind: "text",
    title: "Published lines",
    path,
  });
  const first = await session.call("read", { nodeId: created.value.id });
  expect(first.result.details.readObservation).toMatchObject({
    position: { unit: "lines", line: 1, returnedLines: 200 },
  });
  await k.db.pool.query(
    "update read_cursors set expires_at=now()-interval '1 second' where id=$1",
    [first.value.nextCursor],
  );
  const expired = await session.call("read_next", { cursor: first.value.nextCursor });
  expect(expired.value.error.reopen).toMatchObject({
    nodeId: created.value.id,
    sourceVersion: first.value.sourceVersion,
    line: 201,
  });
  const next = await session.call("read", expired.value.error.reopen);
  expect(next.result.isError).not.toBe(true);
  expect(next.value).toMatchObject({ offset: 201, returnedLines: 200 });
  const wrongUnit = await session.call("read", { nodeId: created.value.id, characterOffset: 6000 });
  expect(wrongUnit.value.error.code).toBe("READ_POSITION");
});

it("the model reading-state projection hides revoked path, node and receipt metadata", async () => {
  const member = await agent(),
    session = await start(member.id);
  const path = join(await k.host.workspace(board), "grant-only.txt");
  await writeFile(path, "Previously authorized content");
  const node = (
    await k.graph.createNode({
      kind: "text",
      parentId: board,
      title: "Grant-only resource",
      text: "Resource note",
      resource: { type: "file", path },
      position: { x: 0, y: 0, width: 220, height: 160 },
      idempotencyKey: key(),
    })
  ).node;
  const link = await k.graph.createLink({
    fromId: member.id,
    toId: node.id,
    idempotencyKey: key(),
  });
  const pathRead = await session.call("read", { path });
  const nodeRead = await session.call("read", { nodeId: node.id });
  expect(pathRead.result.isError).not.toBe(true);
  expect(nodeRead.result.isError).not.toBe(true);
  await k.db.canvas(board, (tx) =>
    recordReadObservations(tx, session.run.subject_id, [
      checkpointResult(pathRead),
      checkpointResult(nodeRead),
    ]),
  );
  expect(await session.tools.readObservations!()).toHaveLength(2);
  await k.graph.deleteLink(link.edge.id, { idempotencyKey: key() });
  expect(await session.tools.readObservations!()).toEqual([]);
  expect(
    (
      await k.db.pool.query(
        "select count(*)::int as count from read_observations where conversation_id=$1",
        [session.run.subject_id],
      )
    ).rows[0].count,
  ).toBe(2);
});
