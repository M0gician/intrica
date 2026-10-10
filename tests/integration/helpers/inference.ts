import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, type Kernel } from "@intrica/server";
import pg from "pg";
import { afterAll, afterEach, beforeAll, expect, vi } from "vitest";
import { withModelUsage } from "../../../apps/server/dist/adapters/model/usage.js";
import type { ExecutionContext } from "../../../apps/server/dist/modules/execution/worker.js";
import type { ToolSet } from "../../../apps/server/dist/modules/work/tools.js";
import { deferred, type ResponsesWire, responseEndpoint } from "../../fixtures/inference-wire.js";

export const key = () => randomUUID();
export type InferenceSession = {
  canvasId: string;
  inputId: string;
  conversationId: string;
  run: ExecutionContext["run"];
  ctx: ExecutionContext;
  execute: () => Promise<void>;
};
type Harness = {
  k: Kernel;
  endpoint: Awaited<ReturnType<typeof responseEndpoint>>;
  session: (configure?: (tools: ToolSet) => void) => Promise<InferenceSession>;
  watch: (canvasId: string, predicate: () => Promise<boolean>) => Promise<void>;
  exists: (query: string, values: unknown[]) => Promise<boolean>;
  nextWhile: (done: Promise<unknown>) => Promise<ResponsesWire>;
};
export function inferenceHarness(): Harness {
  const database = `intrica_inference_${key().replaceAll("-", "")}`;
  let app: Awaited<ReturnType<typeof buildServer>>, k: Kernel, admin: pg.Client, directory: string;
  let endpoint: Awaited<ReturnType<typeof responseEndpoint>>;
  beforeAll(async () => {
    const url = new URL(process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres");
    admin = new pg.Client({ connectionString: url.href });
    await admin.connect();
    await admin.query(`create database ${database}`);
    url.pathname = `/${database}`;
    directory = await mkdtemp(join(tmpdir(), "intrica-inference-"));
    endpoint = await responseEndpoint();
    app = await buildServer({
      databaseUrl: url.href,
      dataDir: directory,
      worker: false,
      model: {
        kind: "pi",
        provider: "openai",
        modelId: "inference-fixture",
        api: "openai-responses",
        baseUrl: endpoint.url,
        apiKey: "fixture",
        supportsVision: false,
      },
    });
    await app.ready();
    k = app.kernel;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    endpoint.closeConnections();
    await k.db.pool.query(
      "update runs set state='cancelled' where state in('queued','running','waiting')",
    );
    await k.db.pool.query(
      "update messages set content=content||'{\"closed\":true}' where consumed_run_id is null",
    );
  });
  afterAll(async () => {
    await endpoint?.close();
    await app?.close();
    await admin.query(`drop database if exists ${database} with(force)`);
    await admin.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function session(configure?: (tools: ToolSet) => void) {
    const canvasId = (
      await k.graph.createCanvas({ title: "Inference lifecycle", idempotencyKey: key() })
    ).node.id;
    const inputId = key();
    const submission = await k.conversations.submit({
      canvasId,
      message: "Inspect this isolated fixture",
      key: inputId,
    });
    const run = (await k.runs.claim("inference-test"))!;
    expect(run.id).toBe(submission.run.id);
    const ctx = { run, store: k.runs, signal: new AbortController().signal, progress() {} };
    return {
      canvasId,
      inputId,
      run,
      ctx,
      conversationId: submission.conversationId,
      execute: () =>
        withModelUsage(
          {
            db: k.db,
            purpose: "conversation",
            model: run.frozen_input.model,
            runId: run.id,
            attemptId: run.attemptId,
            canvasId,
            conversationId: submission.conversationId,
          },
          () =>
            k.conversations.execute(ctx, async (ctx, input) => {
              const tools = await k.tools.create(ctx, input);
              configure?.(tools);
              return tools;
            }),
        ),
    };
  }
  async function watch(canvasId: string, predicate: () => Promise<boolean>) {
    const complete = deferred();
    let pending = false,
      stopped = false,
      dirty = false;
    const check = async () => {
      if (stopped) return;
      if (pending) {
        dirty = true;
        return;
      }
      pending = true;
      try {
        do {
          dirty = false;
          if (await predicate()) complete.resolve();
        } while (dirty);
      } catch (error) {
        complete.reject(error);
      } finally {
        pending = false;
      }
    };
    const close = await k.db.listen("intrica_changes", (id) => {
      if (id === canvasId) void check();
    });
    const timer = setTimeout(
      () => complete.reject(new Error("Expected durable transition was not observed")),
      10_000,
    );
    await check();
    try {
      await complete.promise;
    } finally {
      stopped = true;
      clearTimeout(timer);
      close();
    }
  }
  const nextWhile = (done: Promise<unknown>) =>
    Promise.race([
      endpoint.next(),
      done.then(() => {
        throw new Error("Run ended before its expected next request");
      }),
    ]);
  const exists = async (query: string, values: unknown[]) =>
    Boolean((await k.db.pool.query(query, values)).rowCount);

  return {
    get k() {
      return k;
    },
    get endpoint() {
      return endpoint;
    },
    session,
    watch,
    exists,
    nextWhile,
  };
}
