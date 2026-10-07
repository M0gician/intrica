import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import type { ApiConfig } from "../config.js";

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("node:child_process", () => ({ fork }));

import { superviseWorker } from "./supervisor.js";

function worker(ready: boolean) {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as string | null,
    send: () => queueMicrotask(() => (ready ? child.emit("message", { type: "ready" }) : exit())),
    kill: vi.fn(() => {
      exit();
      return true;
    }),
  });
  function exit() {
    child.exitCode = 1;
    child.emit("exit", 1);
  }
  return child;
}
afterEach(() => {
  vi.useRealTimers();
  fork.mockReset();
});
test("initial failure stops without an orphan restart loop", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fork.mockImplementation(() => worker(false));
  await expect(superviseWorker({} as ApiConfig)).rejects.toThrow("启动完成前退出");
  await vi.advanceTimersByTimeAsync(3000);
  expect(fork).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
test("ready workers still restart after a crash and stop cleanly", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const first = worker(true),
    second = worker(true);
  fork.mockReturnValueOnce(first).mockReturnValueOnce(second);
  const supervisor = await superviseWorker({} as ApiConfig);
  first.kill();
  await vi.advanceTimersByTimeAsync(1000);
  expect(fork).toHaveBeenCalledTimes(2);
  await supervisor.close();
  expect(second.kill).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
