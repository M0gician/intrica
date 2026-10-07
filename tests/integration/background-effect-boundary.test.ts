import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { Agent } from "../../apps/server/dist/adapters/model/agent.js";
import { DEFAULT_LIMITS } from "../../apps/server/dist/modules/execution/limits.js";
import { type ExecutionTool, result } from "../../apps/server/dist/modules/execution/tool-calls.js";

// Characterization of a KNOWN LIMITATION, not a safety/regression guarantee:
// effect=external prevents parallel read batching, but a background receipt does
// not establish a happens-before dependency between side effects. These tests
// deliberately pass when two successful calls finish in the opposite order and
// the older same-path write overwrites the newer write. If serialization or
// dependencies are implemented, replace this contract with the intended policy.
const key = () => randomUUID();
const dbName = `intrica_background_effect_${key().replaceAll("-", "")}`;
let app: Awaited<ReturnType<typeof buildServer>>, k: Kernel, dir: string, admin: pg.Client;
const releases: Array<() => void> = [];
const executions: Promise<unknown>[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  releases.push(resolve);
  return { promise, resolve };
}
beforeAll(async () => {
  const adminUrl = process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres";
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  dir = await mkdtemp(join(tmpdir(), "intrica-background-effect-"));
  app = await buildServer({
    databaseUrl: url.href,
    dataDir: dir,
    accessToken: key(),
    worker: false,
    model: { kind: "mock", supportsVision: false, streamDelayMs: 0 },
    execution: {
      ...DEFAULT_LIMITS,
      toolAsyncAfterMs: 30,
      toolNoticeMs: 60_000,
      toolTimeoutMs: 60_000,
    },
  });
  await app.ready();
  k = app.kernel;
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(executions.splice(0));
  vi.restoreAllMocks();
  await k.db.pool.query("update conversations set consumed_message_seq=message_seq");
  await k.db.pool.query(
    "update runs set state='cancelled',cancel_requested_at=now() where state in('queued','running','waiting')",
  );
});
afterAll(async () => {
  await app?.close();
  await admin.query(`drop database if exists ${dbName} with(force)`);
  await admin.end();
  if (dir) await rm(dir, { recursive: true, force: true });
});

type ModelMessage = Awaited<ReturnType<Agent["turn"]>>;
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const toolCall = (value: string, path: string) => ({
  type: "toolCall" as const,
  id: `write-${value}`,
  name: "write_fixture",
  arguments: { path, value },
});

it.each(["same-batch", "next-model-turn"] as const)(
  "B01 current limitation: %s same-path effects overlap after detachment and the earlier write can win last",
  async (placement) => {
    const canvasId = (
      await k.graph.createCanvas({ title: "effect order boundary", idempotencyKey: key() })
    ).node.id;
    const submitted = await k.conversations.submit({
      canvasId,
      message: "write first, then second",
      key: key(),
    });
    const run = (await k.runs.claim("effect-boundary"))!;
    expect(run.id).toBe(submitted.run.id);
    const path = join(dir, `${placement}-${key()}.txt`);
    await writeFile(path, "initial");
    const template: ModelMessage = {
      role: "assistant",
      api: "openai-completions",
      provider: "test",
      model: "test",
      content: [
        toolCall("first", path),
        ...(placement === "same-batch" ? [toolCall("second", path)] : []),
      ],
      stopReason: "toolUse",
      timestamp: Date.now(),
      usage,
    };
    await k.db.pool.query(
      "update conversations set checkpoint=$2,consumed_message_seq=message_seq,context=$3 where id=$1",
      [
        submitted.conversationId,
        JSON.stringify([template]),
        JSON.stringify({ pendingTurnId: "ordered-intent" }),
      ],
    );
    const releaseFirst = deferred(),
      starts: string[] = [],
      completions: string[] = [];
    let modelTurns = 0;
    vi.spyOn(Agent.prototype, "turn").mockImplementation(async function (this: Agent) {
      const issueSecond = placement === "next-model-turn" && modelTurns++ === 0;
      if (issueSecond) {
        // The second model turn sees a running receipt, not the first final result.
        expect(
          this.state.messages.some(
            (message) =>
              message.role === "toolResult" &&
              message.content.some(
                (part) => part.type === "text" && part.text.includes('"asynchronous":true'),
              ),
          ),
        ).toBe(true);
        expect(completions).toEqual([]);
      }
      const message: ModelMessage = {
        ...template,
        content: issueSecond
          ? [toolCall("second", path)]
          : [{ type: "text", text: "Observe durable tool outcomes." }],
        stopReason: issueSecond ? "toolUse" : "stop",
      };
      this.state.messages.push(message);
      return message;
    });
    const tool: ExecutionTool = {
      name: "write_fixture",
      label: "Controlled external file write",
      description:
        "Test-only write with an explicit completion gate; no resource lock or dependency.",
      parameters: Type.Object({ path: Type.String(), value: Type.String() }),
      effect: "external",
      // Absence of parallel:true must not be mistaken for completion serialization.
      execute: async (_id, args, signal) => {
        starts.push(args.value);
        if (args.value === "first") await releaseFirst.promise;
        signal.throwIfAborted();
        await writeFile(args.path, args.value);
        completions.push(args.value);
        return result({ path: args.path, value: args.value, written: true });
      },
    };
    const ctx = { run, store: k.runs, signal: new AbortController().signal, progress() {} };
    const execution = k.conversations.execute(ctx, async () => [tool]);
    executions.push(execution);
    void execution.catch(() => {});
    try {
      await expect
        .poll(
          async () =>
            (
              await k.db.pool.query(
                "select state from tool_calls where run_id=$1 and args->>'value'='second'",
                [run.id],
              )
            ).rows[0]?.state,
        )
        .toBe("succeeded");
      const first = (
        await k.db.pool.query(
          "select state,is_async from tool_calls where run_id=$1 and args->>'value'='first'",
          [run.id],
        )
      ).rows[0];
      expect(first).toEqual({ state: "dispatching", is_async: true });
      expect(starts).toEqual(["first", "second"]);
      expect(completions).toEqual(["second"]);
      expect(await readFile(path, "utf8")).toBe("second");
      releaseFirst.resolve();
      await execution;
      expect(completions).toEqual(["second", "first"]);
      // Both tool records say success. The actual file disproves submission-order
      // write semantics; a green test here only means the hazard was reproduced.
      expect(await readFile(path, "utf8")).toBe("first");
      const calls = (
        await k.db.pool.query(
          "select id,state,result,args,created_at from tool_calls where run_id=$1 order by created_at,id",
          [run.id],
        )
      ).rows;
      expect(calls).toHaveLength(2);
      expect(calls.map((call) => call.args.value)).toEqual(["first", "second"]);
      expect(calls.map((call) => call.state)).toEqual(["succeeded", "succeeded"]);
      expect(calls.map((call) => JSON.parse(call.result.content[0].text).value)).toEqual([
        "first",
        "second",
      ]);
      const history = await k.conversations.read.history(submitted.conversationId);
      expect(
        history.filter(
          (message) =>
            message.role === "tool_update" &&
            message.content.callId === calls[0].id &&
            message.content.status === "succeeded",
        ),
      ).toHaveLength(1);
      expect((await k.runs.get(run.id)).state).toBe("succeeded");
    } finally {
      releaseFirst.resolve();
      await execution;
    }
  },
);
