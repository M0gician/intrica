import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionServices, createSessionConnection } from "../../api/connection";
import { InputReceipt } from "./InputReceipt";

afterEach(cleanup);
it("uses distinct durable IDs, disables repeat expedite and explains the read state", async () => {
  const connection = createSessionConnection("", "receipts");
  connection.transport.json = vi.fn(async () => ({ state: "read" })) as any;
  const view = (state: "unread" | "read") => (
    <ConnectionServices.Provider value={connection}>
      <InputReceipt conversationId="conversation" receipt={{ messageId: "message-id", state }} />
    </ConnectionServices.Provider>
  );
  const { rerender } = render(view("unread"));
  expect(screen.getByRole("status", { name: "未读" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "加急" }));
  expect(screen.queryByRole("button", { name: "加急" })).toBeNull();
  await screen.findByRole("status", { name: "已读" });
  expect(connection.transport.json).toHaveBeenCalledWith(
    "POST",
    "/api/v2/conversations/conversation/expedite",
    { messageId: "message-id" },
  );
  rerender(view("read"));
  expect(screen.getByRole("status").title).toBe("已加入模型上下文");
});
