import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sshTarget } from "./ssh-target.mjs";

const terminal = new Set(["completed", "failed", "cancelled"]);

/** Application-owned installation state. No tokens or remote command output is persisted. */
export function createSshOperations({ version, userData, execute, now = Date.now }) {
  const release = /^\d+\.\d+\.\d+$/.test(version ?? "") ? `v${version}` : null;
  const path = userData && join(userData, "ssh-operation.json");
  let operation = null,
    running,
    abort,
    lastSaved = 0;
  if (path) {
    try {
      const saved = JSON.parse(readFileSync(path, "utf8"));
      if (saved.format === 1 && typeof saved.operation?.id === "string") {
        operation = saved.operation;
        sshTarget(operation.target);
        if (!terminal.has(operation.phase)) {
          operation.phase = "failed";
          operation.error = { code: "INSTALL_INTERRUPTED" };
          operation.cancellable = false;
        }
      }
    } catch {
      operation = null;
    }
  }
  const snapshot = () => ({ release, operation: operation && structuredClone(operation) });
  const persist = (force = true) => {
    if (!path || (!force && now() - lastSaved < 250)) return;
    mkdirSync(userData, { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify({ format: 1, operation }), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    lastSaved = now();
  };
  const progress = (value) => {
    const changed = operation.phase !== value.phase;
    if (changed) {
      operation.phaseStartedAt = now();
      delete operation.transferredBytes;
      delete operation.totalBytes;
    }
    Object.assign(operation, value, { updatedAt: now() });
    persist(changed);
  };
  return {
    state: snapshot,
    busy: () => Boolean(running),
    safeToQuit: () => !running || operation.cancellable,
    async settle() {
      await running;
    },
    install(input) {
      if (!release) throw new Error("The client has no matching stable server release.");
      if (
        !input ||
        Object.keys(input).some((key) => !["target", "sandbox", "operationId"].includes(key))
      )
        throw new Error("Invalid installation request.");
      const target = sshTarget(input.target);
      if (!["required", "disabled"].includes(input.sandbox))
        throw new Error("Choose an execution mode.");
      if (running) {
        if (operation.alias !== target.alias || operation.sandbox !== input.sandbox)
          throw new Error("Another server installation is in progress.");
        return snapshot();
      }
      if (
        input.operationId &&
        (input.operationId !== operation?.id ||
          operation.alias !== target.alias ||
          operation.release !== release ||
          operation.sandbox !== input.sandbox)
      )
        throw new Error("The installation target changed. Start a new operation.");
      if (input.operationId && operation.phase === "completed") return snapshot();
      operation = {
        id: input.operationId ?? randomUUID(),
        alias: target.alias,
        target: input.target,
        release,
        sandbox: input.sandbox,
        phase: "checking",
        cancellable: true,
        startedAt: now(),
        phaseStartedAt: now(),
        updatedAt: now(),
        lingerChanged: Boolean(input.operationId && operation?.lingerChanged),
      };
      persist();
      abort = new AbortController();
      const signal = abort.signal;
      // Acquire ownership before execute can yield or a second renderer can start.
      running = Promise.resolve().then(async () => {
        try {
          const profile = await execute(operation, { signal, onProgress: progress });
          signal.throwIfAborted();
          operation.profile = profile;
          progress({ phase: "completed", cancellable: false });
        } catch (error) {
          operation.error = signal.aborted
            ? null
            : {
                code: error.code ?? "INSTALL_FAILED",
                message: error.message,
                ...(error.remediation ? { remediation: error.remediation } : {}),
              };
          try {
            progress({ phase: signal.aborted ? "cancelled" : "failed", cancellable: false });
          } catch {
            /* Retain the in-memory failure if the local disk is unavailable. */
          }
        } finally {
          running = undefined;
          abort = undefined;
        }
      });
      return snapshot();
    },
    cancel(id) {
      if (running && id === operation.id) {
        operation.cancelRequested = true;
        abort.abort(new Error("Installation cancelled."));
        persist();
      }
      return snapshot();
    },
  };
}
