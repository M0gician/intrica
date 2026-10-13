import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ProcessOutcomeError } from "../../apps/server/dist/adapters/host/process-outcome.js";
import { runProcess } from "../../apps/server/dist/adapters/host/sandbox.js";

let cwd: string;
beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "process-results-"));
});
afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});
it.each([0, 1, 7, 127])("retains actual exit %i without claiming task acceptance", async (code) => {
  const output = await runProcess(
    process.execPath,
    ["-e", `process.stdout.write('evidence');process.exit(${code})`],
    cwd,
    { PATH: process.env.PATH! },
    new AbortController().signal,
  );
  expect(output).toEqual({
    output: "evidence",
    exitCode: code,
    signal: null,
    termination: "exited",
    taskStatus: "unverified",
  });
});
it("preserves the actual signal without treating SIGPIPE as success", async () => {
  const output = await runProcess(
    "/bin/sh",
    ["-c", "kill -PIPE $$"],
    cwd,
    { PATH: process.env.PATH! },
    new AbortController().signal,
  );
  expect(output).toMatchObject({
    exitCode: null,
    signal: "SIGPIPE",
    termination: "signal",
    taskStatus: "unverified",
  });
});
it("retains bounded output for timeouts and cancellation, and distinguishes confirmed spawn failure", async () => {
  for (const terminate of ["timed_out", "cancelled"] as const) {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = runProcess(
      process.execPath,
      ["-e", "console.log('started');setInterval(()=>{},100)"],
      cwd,
      { PATH: process.env.PATH! },
      abort.signal,
      terminate === "timed_out" ? 250 : 5000,
      false,
      () => {
        if (terminate === "cancelled") timer = setTimeout(() => abort.abort(), 20);
      },
    );
    const error = await promise.catch((error) => error);
    clearTimeout(timer);
    expect(error).toBeInstanceOf(ProcessOutcomeError);
    expect(error.outcome).toMatchObject({
      termination: terminate,
      output: expect.stringContaining("started"),
      taskStatus: "unverified",
    });
  }
  const error = await runProcess(
    join(cwd, "missing-program"),
    [],
    cwd,
    {},
    new AbortController().signal,
  ).catch((error) => error);
  expect(error.outcome).toMatchObject({
    termination: "start_failed",
    errorCode: "ENOENT",
    exitCode: null,
  });
});
