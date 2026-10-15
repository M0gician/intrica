import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { persistContextArchive } from "../../apps/server/dist/modules/work/context-library/archive.js";
import {
  readContextLibrary,
  readOwnerContextLibrary,
} from "../../apps/server/dist/modules/work/context-library/service.js";
import { agent, board, k, key, start } from "./helpers/runtime-redesign.js";

type Session = Awaited<ReturnType<typeof start>>;
async function archive(session: Session, messages: any[], summary = "Archived analysis") {
  const id = `summary-${key()}`;
  await k.db.canvas(board, async (tx) => {
    await tx.query(
      `insert into context_summaries(id,conversation_id,run_id,request_id,source_hash,source_refs,instruction_hash,content,previous_checkpoint,context_version)
       select $1,$2,$3,$4,'fixture','[]','fixture',$5,'[]',coalesce(max(context_version)+1,0) from context_summaries where conversation_id=$2`,
      [id, session.run.subject_id, session.run.id, key(), JSON.stringify({ text: summary })],
    );
    await persistContextArchive(tx, {
      summaryId: id,
      conversationId: session.run.subject_id,
      canvasId: board,
      agentId: session.actor.agentId,
      sourceMessages: messages,
    });
  });
  return `context:${id}`;
}

it("makes 30 archived versions searchable and exactly recoverable for a read-only agent without creating nodes or granting resources", async () => {
  const session = await start((await agent(board, "read")).id);
  const count = async (table: "nodes" | "grants") =>
    Number(
      (await k.db.pool.query(`select count(*) as count from ${table} where canvas_id=$1`, [board]))
        .rows[0].count,
    );
  const before = { nodes: await count("nodes"), grants: await count("grants") };
  const texts = Array.from(
    { length: 30 },
    (_, index) =>
      `phase-${String(index).padStart(2, "0")} unique evidence\n${"中文😀 exact data\n".repeat(1000)}`,
  );
  for (const [index, text] of texts.entries())
    await archive(
      session,
      [
        {
          role: "toolResult",
          toolCallId: `read-${index}`,
          toolName: "read",
          isError: false,
          content: [{ type: "text", text }],
          timestamp: index,
        },
      ],
      `Phase ${index}`,
    );
  const queries: string[] = [];
  const canvas = k.db.canvas.bind(k.db);
  const intercept = vi.spyOn(k.db, "canvas").mockImplementation((id, action, includeDeleted) =>
    canvas(
      id,
      async (tx) => {
        const query = vi.spyOn(tx, "query");
        try {
          return await action(tx);
        } finally {
          queries.push(...query.mock.calls.map(([text]) => String(text)));
          query.mockRestore();
        }
      },
      includeDeleted,
    ),
  );
  try {
    const directory = await readOwnerContextLibrary(k.db, session.run.subject_id, {
      query: "unique evidence",
    });
    expect(directory.kind).toBe("directory");
    if (directory.kind === "directory") {
      expect(directory.archives).toHaveLength(20);
      expect(directory.archives.every((entry) => entry.matches?.length === 1)).toBe(true);
    }
    expect(
      queries.filter((query) => query.includes("jsonb_array_elements(s.source_messages)")),
    ).toHaveLength(1);
  } finally {
    intercept.mockRestore();
  }
  const first = (await session.call("read_context", {})).value;
  expect(first.archives).toHaveLength(20);
  expect(first.nextOffset).toBe(20);
  const second = (await session.call("read_context", { offset: first.nextOffset })).value;
  expect(second.archives).toHaveLength(10);
  expect(second.nextOffset).toBeNull();
  const found = (await session.call("read_context", { query: "phase-13" })).value;
  expect(found.archives).toHaveLength(1);
  const overview = (
    await session.call("read_context", { ref: found.archives[0].ref, query: "phase-13" })
  ).value;
  expect(overview.sources).toHaveLength(1);
  expect(overview.sources[0]).toMatchObject({
    logicalToolCallId: "read-13",
    toolName: "read",
    isError: false,
  });
  let offset = 0,
    recovered = "";
  for (;;) {
    const page = (
      await session.call("read_context", { ref: overview.sources[0].ref, offset, limit: 1700 })
    ).value;
    recovered += page.text;
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  expect(recovered).toBe(texts[13]);
  const canvasView = (await session.call("read_canvas", {})).value;
  expect(canvasView.contextLibrary).toMatchObject({
    tool: "read_context",
    private: true,
    latestRef: first.archives[0].ref,
  });
  expect({ nodes: await count("nodes"), grants: await count("grants") }).toEqual(before);
});

it("keeps archives private even when another agent has management authority", async () => {
  const manager = await agent(board, "admin");
  const child = await start((await agent(manager.id, "read")).id);
  const ref = await archive(child, [
    { role: "user", content: "private exact evidence", timestamp: 0 },
  ]);
  const other = await start(manager.id);
  const denied = await other.call("read_context", { ref });
  expect(denied.result.isError).toBe(true);
  expect(JSON.stringify(denied.value)).not.toContain("private exact evidence");
  await expect(
    readContextLibrary(k.db, other.actor, board, child.run.subject_id),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("rechecks revoked scope for directory and body and carries that scope into later summaries", async () => {
  const member = await agent(board, "admin");
  const resource = (
    await k.graph.createNode({
      kind: "text",
      parentId: board,
      title: "Private source",
      text: "secret",
      position: { x: 0, y: 0, width: 220, height: 180 },
      idempotencyKey: key(),
    })
  ).node;
  await k.graph.createLink({ fromId: member.id, toId: resource.id, idempotencyKey: key() });
  const session = await start(member.id);
  const first = await archive(session, [
    { role: "user", content: "secret evidence", timestamp: 0 },
  ]);
  expect((await session.call("read_context", {})).value.archives).toHaveLength(1);
  // This isolates post-revocation source authorization; graph cancellation has its own tests.
  await k.db.pool.query("delete from grants where subject_id=$1 and resource_id=$2", [
    member.id,
    resource.id,
  ]);
  const next = await archive(session, [
    {
      role: "assistant",
      intrica: { kind: "summary", id: first.slice("context:".length) },
      content: [{ type: "text", text: "secret derived conclusion" }],
      timestamp: 1,
    },
  ]);
  expect((await session.call("read_context", {})).value.archives).toEqual([]);
  for (const ref of [first, `${first}:0`, next, `${next}:summary`]) {
    const response = await session.call("read_context", { ref });
    expect(response.result.isError).toBe(true);
    expect(JSON.stringify(response.value)).not.toContain("secret");
  }
  // User ownership remains distinct from an Agent's administrator role.
  const owner = await readOwnerContextLibrary(k.db, session.run.subject_id, { ref: `${first}:0` });
  expect(owner.kind === "source" && owner.text).toBe("secret evidence");
});

it("keeps complete long handoffs readable separately from the overview preview", async () => {
  const session = await start((await agent()).id);
  const summary = `decision\n${"handoff 😀\n".repeat(1000)}exact final constraint`;
  const ref = await archive(session, [{ role: "user", content: "source", timestamp: 0 }], summary);
  const found = (await session.call("read_context", { query: "final constraint" })).value;
  expect(found.archives).toHaveLength(1);
  expect(found.archives[0].ref).toBe(ref);
  expect(found.archives[0].matches[0].ref).toBe(`${ref}:summary`);
  const summaryHit = (await session.call("read_context", { ref, query: "final constraint" })).value;
  expect(summaryHit.sources).toEqual([]);
  const overview = (await session.call("read_context", { ref })).value;
  expect(overview.summaryTruncated).toBe(true);
  let text = "",
    offset = 0;
  for (;;) {
    const page = (await session.call("read_context", { ref: overview.summaryRef, offset })).value;
    text += page.text;
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  expect(text).toBe(summary);
});

it("ranks multiple literal search terms and returns direct source positions without expanding access", async () => {
  const session = await start((await agent(board, "read")).id);
  const weak = await archive(
    session,
    [{ role: "user", content: "Authentication notes", timestamp: 0 }],
    "Index",
  );
  const strong = await archive(
    session,
    [
      {
        role: "user",
        content: `${"padding\n".repeat(1000)}Authentication audit: cacheTtlSeconds=287; failedCase=case-331`,
        timestamp: 1,
      },
    ],
    "Index",
  );
  const found = (
    await session.call("read_context", { query: "Authentication cacheTtlSeconds failedCase" })
  ).value;
  expect(found.archives.map((item: any) => item.ref)).toEqual([strong, weak]);
  const match = found.archives[0].matches[0];
  const page = (await session.call("read_context", { ref: match.ref, offset: match.matchOffset }))
    .value;
  expect(page.text).toBe("Authentication audit: cacheTtlSeconds=287; failedCase=case-331");
  const stranger = await start((await agent()).id);
  expect(
    (await stranger.call("read_context", { query: "Authentication cacheTtlSeconds" })).value
      .archives,
  ).toEqual([]);
});

it("classifies background receipts as tool evidence and links both delivery forms to the durable call", async () => {
  const member = await agent(board, "read");
  const session = await start(member.id);
  const path = join(await k.host.workspace(board, member.id), "receipt.txt");
  await writeFile(path, "exact tool evidence");
  const read = await session.call("read", { path });
  const callId = read.value.call.callId;
  const ref = await archive(session, [
    {
      role: "toolResult",
      toolCallId: "provider-call",
      toolName: "read",
      isError: false,
      content: read.result.content,
      details: read.result.details,
      timestamp: 0,
    },
    {
      role: "user",
      intrica: { kind: "input", id: "background-notice" },
      intricaCallId: callId,
      content: read.result.content,
      timestamp: 1,
    },
  ]);
  const overview = (await session.call("read_context", { ref })).value;
  expect(overview.sources).toHaveLength(2);
  for (const source of overview.sources) {
    expect(source).toMatchObject({
      role: "toolResult",
      evidenceRef: callId,
      toolName: "read",
      isError: false,
    });
    const page = (await session.call("read_context", { ref: source.ref })).value;
    expect(page.evidenceRef).toBe(callId);
  }
  expect(
    Number(
      (
        await k.db.pool.query(
          "select count(*) as count from tool_calls where run_id=$1 and name='read'",
          [session.run.id],
        )
      ).rows[0].count,
    ),
  ).toBe(1);
});

it("validates query fields at the tool boundary and source positions against stored evidence", async () => {
  const session = await start((await agent(board, "read")).id);
  for (const args of [
    { offset: -1 },
    { offset: 1.5 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 },
    { limit: 6001 },
    { query: "x".repeat(201) },
  ]) {
    const rejected = await session.call("read_context", args);
    expect(rejected.value.error).toMatchObject({ code: "TOOL_ARGUMENTS" });
    expect(rejected.value.call.effect).toBe("none");
  }
  const ref = await archive(session, [{ role: "user", content: "a😀z", timestamp: 0 }]);
  const source = (await session.call("read_context", { ref })).value.sources[0].ref;
  for (const offset of [2, 10]) {
    const rejected = await session.call("read_context", { ref: source, offset });
    expect(rejected.value.error.code).toBe("CONTEXT_OFFSET");
  }
});
