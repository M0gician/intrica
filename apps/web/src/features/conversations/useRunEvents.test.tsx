import type { Transport } from "@intrica/client";
import { expect, it, vi } from "vitest";
import { createSessionConnection } from "../../api/connection";
import { act, renderHook } from "../../test/render";
import { useRunEvents } from "./useRunEvents";

it("discards the previous message after reset and reconnects once at the recovered cursor", async () => {
  const connection = createSessionConnection();
  const listeners: Parameters<Transport["subscribe"]>[2][] = [];
  const close = vi.fn();
  const subscribe = vi
    .spyOn(connection.transport, "subscribe")
    .mockImplementation((_path, cursor, events) => {
      listeners.push(events);
      return { cursor, close };
    });
  let complete!: (value: { runId: string; cursor: string }) => void;
  const recover = vi.fn(
    () =>
      new Promise<{ runId: string; cursor: string }>((resolve) => {
        complete = resolve;
      }),
  );
  const onEvent = vi.fn();
  const view = renderHook(
    () =>
      useRunEvents({ active: true, runId: "run", cursor: "0", recover, onEvent, onError: vi.fn() }),
    { connection },
  );
  try {
    act(() =>
      listeners[0]!.onEvent({
        seq: "1",
        type: "message",
        payload: { id: "message", text: "old", thinking: "", revision: 5 },
      }),
    );
    act(() => {
      listeners[0]!.onReset();
      listeners[0]!.onReset();
    });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    await act(async () => complete({ runId: "run", cursor: "9" }));
    expect(subscribe.mock.calls.map((call) => call[1])).toEqual(["0", "9"]);
    act(() =>
      listeners[1]!.onEvent({
        seq: "10",
        type: "message",
        payload: { id: "message", text: "restored", thinking: "", revision: 1 },
      }),
    );
    expect(onEvent.mock.calls.at(-1)![0].payload.text).toBe("restored");
  } finally {
    view.unmount();
    connection.dispose();
  }
});

it("suppresses a failed delta recovery after the consumer unmounts", async () => {
  const connection = createSessionConnection();
  let events!: Parameters<Transport["subscribe"]>[2];
  vi.spyOn(connection.transport, "subscribe").mockImplementation((_path, cursor, listeners) => {
    events = listeners;
    return { cursor, close() {} };
  });
  let reject!: (error: Error) => void;
  const recover = () =>
    new Promise<null>((_resolve, fail) => {
      reject = fail;
    });
  const onError = vi.fn();
  const view = renderHook(
    () =>
      useRunEvents({ active: true, runId: "run", cursor: "0", recover, onEvent: vi.fn(), onError }),
    { connection },
  );
  act(() =>
    events.onEvent({
      seq: "1",
      type: "message",
      payload: { id: "missing", delta: true, text: "delta", thinking: "" },
    }),
  );
  view.unmount();
  await act(async () => reject(new Error("late failure")));
  expect(onError).not.toHaveBeenCalled();
  connection.dispose();
});
