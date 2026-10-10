import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionServices, createSessionConnection } from "../../api/connection";
import { ConversationWaits, type MessageWait } from "./ConversationWaits";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("shows a local countdown and keeps wake and cancel separate from sending messages", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const connection = createSessionConnection("", "wait-controls");
  connection.transport.request = vi.fn() as any;
  connection.transport.json = vi.fn(async () => ({ state: "released" })) as any;
  const wait: MessageWait = {
    waitId: "wait-durable",
    mode: "requests",
    deadline: "2026-01-01T00:01:00Z",
    blockedReason: null,
    requests: [
      {
        id: "request",
        recipientName: "Morgan",
        recipientAgentId: "agent",
        receipt: "read",
        elapsedSeconds: 12,
        followupCount: 1,
        workState: "active",
      },
    ],
  };
  const view = (record: MessageWait) => (
    <ConnectionServices.Provider value={connection}>
      <ConversationWaits conversationId="conversation" waits={[record]} />
    </ConnectionServices.Provider>
  );
  const { rerender } = render(view(wait));
  expect(screen.getByText("剩余 60 秒")).toBeTruthy();
  expect(screen.getByText(/Morgan.*已读.*已跟进 1 次/)).toBeTruthy();
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.getByText("剩余 58 秒")).toBeTruthy();
  expect(connection.transport.request).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "现在唤醒" })));
  expect(connection.transport.json).toHaveBeenCalledWith(
    "POST",
    "/api/v2/conversations/conversation/waits/wait-durable",
    { action: "wake" },
  );
  rerender(view({ ...wait, blockedReason: "unknown" }));
  expect((screen.getByRole("button", { name: "现在唤醒" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "取消等待" })));
  expect(connection.transport.json).toHaveBeenLastCalledWith(
    "POST",
    "/api/v2/conversations/conversation/waits/wait-durable",
    { action: "cancel" },
  );
  connection.dispose();
});
