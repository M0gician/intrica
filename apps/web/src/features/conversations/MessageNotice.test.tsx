import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ConnectionServices, createSessionConnection } from "../../api/connection";
import { MessageNotice } from "./MessageNotice";

it("通知提交当前版本和等待时间，并在回复后隐藏跟踪操作", async () => {
  const connection = createSessionConnection("", "notice-actions");
  let current = {
    deliveryId: "request-1",
    pending: true,
    expectReply: true,
    tracking_stopped: false,
    state: "open",
    version: 1,
    readAt: null,
    runState: "waiting",
  };
  connection.transport.request = vi.fn(async () => [current]) as any;
  connection.transport.json = vi.fn(async () => {
    current = { ...current, version: 2 };
    return {};
  }) as any;
  render(
    <ConnectionServices.Provider value={connection}>
      <MessageNotice deliveryIds={["request-1"]} conversationId="conversation-1" />
    </ConnectionServices.Provider>,
  );
  await screen.findByText("尚未读入上下文");
  fireEvent.change(screen.getByLabelText("等待秒数"), { target: { value: "300" } });
  fireEvent.click(screen.getByText("继续等待"));
  await waitFor(() =>
    expect(connection.transport.json).toHaveBeenCalledWith(
      "POST",
      "/api/v2/message-deliveries/request-1",
      { action: "wait", version: 1, waitSeconds: 300 },
    ),
  );
  await waitFor(() =>
    expect((screen.getByText("继续等待") as HTMLButtonElement).disabled).toBe(false),
  );
  current = { ...current, state: "replied", pending: false, version: 3 };
  connection.activity.invalidate({ conversationId: "conversation-1" });
  await screen.findByText("已收到回复");
  expect(screen.queryByText("加急消息")).toBeNull();
  connection.dispose();
});
