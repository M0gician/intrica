import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSshOperations } from "./ssh-operations.mjs";

const request = { target: "example", sandbox: "required" };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("installation pins the client version and duplicate starts share one operation", async () => {
  const held = deferred();
  let starts = 0;
  const controller = createSshOperations({
    version: "2.4.7",
    execute: async (operation, hooks) => {
      starts++;
      assert.equal(operation.release, "v2.4.7");
      hooks.onProgress({
        phase: "uploading",
        cancellable: true,
        totalBytes: 200,
        transferredBytes: 120,
      });
      await held.promise;
      return { id: "profile", label: "Example", baseUrl: "http://localhost:1234" };
    },
  });
  assert.throws(() => controller.install({ ...request, release: "v9.9.9" }), /Invalid/);
  const first = controller.install(request);
  assert.equal(controller.install(request).operation.id, first.operation.id);
  await Promise.resolve();
  assert.equal(controller.state().operation.transferredBytes, 120);
  assert.equal(starts, 1);
  assert.throws(() => controller.install({ ...request, target: "another" }), /in progress/);
  held.resolve();
  await controller.settle();
  assert.equal(controller.state().operation.phase, "completed");
  controller.install({ ...request, operationId: first.operation.id });
  assert.equal(starts, 1);
});

test("cancel waits for a critical installation step and cannot cancel another operation", async () => {
  const held = deferred();
  let finished = false;
  const controller = createSshOperations({
    version: "1.0.0",
    execute: async (_operation, hooks) => {
      hooks.onProgress({ phase: "installing", cancellable: false });
      await held.promise;
      finished = true;
      hooks.signal.throwIfAborted();
    },
  });
  const first = controller.install(request);
  await Promise.resolve();
  controller.cancel("unrelated");
  assert.equal(controller.state().operation.cancelRequested, undefined);
  assert.equal(controller.safeToQuit(), false);
  controller.cancel(first.operation.id);
  assert.equal(controller.state().operation.phase, "installing");
  assert.equal(finished, false);
  held.resolve();
  await controller.settle();
  assert.equal(finished, true);
  assert.equal(controller.state().operation.phase, "cancelled");
});

test("an interrupted operation resumes with its identity and rechecks through the executor", async (t) => {
  const userData = await mkdtemp(join(tmpdir(), "intrica-operation-"));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const held = deferred();
  const first = createSshOperations({ version: "1.2.3", userData, execute: () => held.promise });
  const started = first.install(request);
  const second = createSshOperations({
    version: "1.2.3",
    userData,
    execute: async () => ({ id: "restored" }),
  });
  assert.equal(second.state().operation.phase, "failed");
  assert.equal(second.state().operation.error.code, "INSTALL_INTERRUPTED");
  assert.throws(
    () => second.install({ ...request, target: "different", operationId: started.operation.id }),
    /changed/,
  );
  second.install({ ...request, operationId: started.operation.id });
  await second.settle();
  const saved = JSON.parse(await readFile(join(userData, "ssh-operation.json"), "utf8"));
  assert.equal(saved.operation.id, started.operation.id);
  assert.equal(saved.operation.phase, "completed");
  held.resolve({ id: "old-process" });
  await first.settle();
});
