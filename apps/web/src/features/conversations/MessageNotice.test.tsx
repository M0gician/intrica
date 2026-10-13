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
  await screen.findByRole("status", { name: "未读" });
  fireEvent.change(screen.getByLabelText("下次提醒"), { target: { value: "300" } });
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
  await screen.findByRole("status", { name: "已收到回复" });
  expect(screen.queryByText("加急消息")).toBeNull();
  connection.dispose();
});

it("invalid custom delay blocks waiting but does not prevent stopping reminders", async () => {
  const connection = createSessionConnection("", "notice-custom");
  const current = {
    deliveryId: "delivery-1",
    recipientName: "成员",
    pending: true,
    state: "open",
    version: 4,
    readAt: null,
    paused: true,
  };
  connection.transport.request = vi.fn(async () => [current]) as any;
  connection.transport.json = vi.fn(async () => ({})) as any;
  render(
    <ConnectionServices.Provider value={connection}>
      <MessageNotice deliveryIds={[current.deliveryId]} />
    </ConnectionServices.Provider>,
  );
  await screen.findByRole("status", { name: "未读" });
  expect(screen.queryByRole("button", { name: "加急消息" })).toBeNull();
  fireEvent.change(screen.getByLabelText("下次提醒"), { target: { value: "custom" } });
  fireEvent.change(screen.getByLabelText("等待秒数"), { target: { value: "0" } });
  expect((screen.getByRole("button", { name: "继续等待" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByText("更多操作"));
  fireEvent.click(screen.getByRole("button", { name: "停止跟踪" }));
  await waitFor(() =>
    expect(connection.transport.json).toHaveBeenCalledWith(
      "POST",
      "/api/v2/message-deliveries/delivery-1",
      { action: "cancel", version: 4 },
    ),
  );
  connection.dispose();
});

it("keeps unresolved closed messages actionable without offering wait or expedite", async () => {
  const connection = createSessionConnection("", "notice-closed");
  connection.transport.request = vi.fn(async () => [
    {
      deliveryId: "closed",
      recipientName: "Former reviewer",
      pending: true,
      closed: true,
      state: "open",
      version: 2,
    },
  ]) as any;
  connection.transport.json = vi.fn(async () => ({})) as any;
  render(
    <ConnectionServices.Provider value={connection}>
      <MessageNotice deliveryIds={["closed"]} />
    </ConnectionServices.Provider>,
  );
  await screen.findByText("Former reviewer");
  expect(screen.queryByRole("button", { name: "继续等待" })).toBeNull();
  expect(screen.queryByRole("button", { name: "加急消息" })).toBeNull();
  expect(screen.queryByLabelText("下次提醒")).toBeNull();
  expect(screen.getByText("此消息已关闭，请核查结果并处理未完成事项。")).toBeTruthy();
  fireEvent.click(screen.getByText("更多操作"));
  fireEvent.click(screen.getByRole("button", { name: "停止跟踪" }));
  await waitFor(() =>
    expect(connection.transport.json).toHaveBeenCalledWith(
      "POST",
      "/api/v2/message-deliveries/closed",
      { action: "cancel", version: 2 },
    ),
  );
  connection.dispose();
});
