import type { CollaborationReceipt } from "@intrica/contracts";
import { expect, it, vi } from "vitest";
import { ConnectionServices, createSessionConnection } from "../../api/connection";
import { fireEvent, render, screen, waitFor } from "../../test/render";
import { DeliveryReceipts } from "./DeliveryReceipts";
import { TimelineEvent } from "./TimelineEvent";

const receipt = (patch: Partial<CollaborationReceipt> = {}): CollaborationReceipt => ({
  deliveryId: "delivery-a",
  recipientId: "a",
  recipientName: "成员甲",
  state: "unread",
  readAt: null,
  expectReply: false,
  replied: false,
  replyMessageId: null,
  replyConversationId: null,
  replySeq: null,
  priority: "normal",
  expeditedAt: null,
  expediteReadAt: null,
  paused: false,
  blocked: false,
  tracking: true,
  version: 3,
  ...patch,
});

it("shows aggregate and individual receipts and expedites only the selected unread recipient", async () => {
  const connection = createSessionConnection("", "delivery-receipts");
  connection.transport.json = vi.fn(async () => ({})) as any;
  render(
    <ConnectionServices.Provider value={connection}>
      <DeliveryReceipts
        conversationId="sender"
        receipts={[
          receipt({ state: "read", readAt: "2026-10-13T05:00:00Z", tracking: false }),
          receipt({ deliveryId: "delivery-b", recipientId: "b", recipientName: "成员乙" }),
        ]}
      />
    </ConnectionServices.Provider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "接收者状态 · 已读 1/2" }));
  expect(screen.getByRole("status", { name: "已读" }).title).toContain("已加入模型上下文");
  expect(screen.getByRole("status", { name: "未读" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "加急消息" }));
  await waitFor(() =>
    expect(connection.transport.json).toHaveBeenCalledWith(
      "POST",
      "/api/v2/message-deliveries/delivery-b",
      { action: "expedite", version: 3, waitSeconds: 120 },
    ),
  );
  connection.dispose();
});

it("shows paused unread messages without offering an action that would resume the Agent", () => {
  const connection = createSessionConnection("", "paused-receipt");
  render(
    <ConnectionServices.Provider value={connection}>
      <DeliveryReceipts receipts={[receipt({ paused: true })]} />
    </ConnectionServices.Provider>,
  );
  expect(screen.getByRole("status", { name: "未读" }).textContent).toBe("");
  expect(screen.getByRole("status", { name: "未读" }).title).toContain("对方已暂停协作");
  expect(screen.queryByRole("button", { name: "加急消息" })).toBeNull();
  connection.dispose();
});

it("retains the expedite marker after a user input has been consumed", () => {
  const connection = createSessionConnection("", "input-priority");
  render(
    <ConnectionServices.Provider value={connection}>
      <TimelineEvent
        event={{
          seq: 1,
          agentId: "a",
          kind: "user",
          data: {
            text: "urgent input",
            inputReceipt: {
              messageId: "input-1",
              state: "read",
              expeditedAt: "2026-10-13T05:00:00Z",
            },
          },
        }}
        nodes={new Map()}
        requestEvent={new Map()}
      />
    </ConnectionServices.Provider>,
  );
  expect(screen.getByRole("status", { name: "已优先送达" })).toBeTruthy();
  expect(screen.getByRole("status", { name: "已读" })).toBeTruthy();
  connection.dispose();
});

it("keeps a single priority label and prevents repeat expediting while the reminder is unread", () => {
  const connection = createSessionConnection("", "pending-priority");
  render(
    <ConnectionServices.Provider value={connection}>
      <TimelineEvent
        event={{
          seq: 1,
          agentId: "a",
          kind: "message",
          data: {
            text: "Please review",
            priority: "expedited",
            deliveryReceipts: [receipt({ priority: "expedited" })],
          },
        }}
        nodes={new Map()}
        requestEvent={new Map()}
      />
    </ConnectionServices.Provider>,
  );
  expect(screen.getAllByRole("status", { name: "加急中" })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "加急消息" })).toBeNull();
  connection.dispose();
});

it("does not offer expedite for a closed recipient with an unresolved tracked request", () => {
  const connection = createSessionConnection("", "closed-delivery");
  render(
    <ConnectionServices.Provider value={connection}>
      <DeliveryReceipts
        receipts={[receipt({ state: "closed", expectReply: true, tracking: true })]}
      />
    </ConnectionServices.Provider>,
  );
  expect(screen.getByRole("status", { name: "消息已关闭" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "加急消息" })).toBeNull();
  expect(screen.getByTitle(/未完成事项/)).toBeTruthy();
  connection.dispose();
});
