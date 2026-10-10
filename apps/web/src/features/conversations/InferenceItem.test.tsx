import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentTimeline } from "./AgentTimeline";
import { InferenceItem } from "./InferenceItem";
import { restoreTurns } from "./workspace-model";

afterEach(cleanup);
function open() {
  const details = document.querySelector("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  return details;
}

it("updates item states in place and keeps context commitment separate from delivery", () => {
  const data = { itemKind: "text", text: "Recorded output", state: "streaming" };
  const view = render(<InferenceItem data={data} />);
  const details = open();
  for (const [state, label] of [
    ["streaming", "正在生成"],
    ["closed", "等待续接数据"],
    ["committed", "已加入模型上下文"],
    ["discarded", "已中断 · 仅保留记录"],
  ]) {
    view.rerender(<InferenceItem data={{ ...data, state }} />);
    expect(screen.getByRole("status").textContent).toBe(label);
    expect(details.open).toBe(true);
    expect(screen.getByText("输出未发布")).toBeTruthy();
    expect(screen.queryByText("已送达")).toBeNull();
  }
  view.rerender(
    <InferenceItem
      data={{ ...data, state: "committed", publication: { state: "sent", messageId: "delivery" } }}
    />,
  );
  expect(screen.getByText("已送达")).toBeTruthy();
});

it("loads the full durable inference record through the Agent timeline disclosure", async () => {
  const load = vi.fn(async () => ({ thinking: "Complete reasoning tail", truncated: false }));
  function Fixture() {
    const [data, setData] = useState({ thinking: "Preview", truncated: true });
    return (
      <AgentTimeline
        nodes={new Map()}
        events={[
          {
            seq: 7,
            conversationId: "conversation",
            agentId: "agent",
            kind: "inference_item",
            recordVersion: "version",
            data: { ...data, itemKind: "thinking", state: "committed" },
          },
        ]}
        onExpandEvent={async (seq) => {
          expect(seq).toBe(7);
          setData(await load());
        }}
      />
    );
  }
  render(<Fixture />);
  expect(screen.queryByText("Preview")).toBeNull();
  const details = open();
  await waitFor(() => expect(screen.getByText("Complete reasoning tail")).toBeTruthy());
  expect(details.open).toBe(true);
  expect(load).toHaveBeenCalledTimes(1);
});

it("restores each durable item and input receipt once from a reconnect snapshot", () => {
  const snapshot = {
    messages: [
      {
        seq: 1,
        role: "user",
        content: { text: "input", inputReceipt: { messageId: "input", state: "read" } },
      },
      ...["committed", "discarded", "closed", "streaming"].map((state, index) => ({
        seq: index + 2,
        role: "inference_item",
        content: { id: `item-${index}`, state, itemKind: "thinking", thinking: `Item ${index}` },
      })),
      { seq: 6, role: "model_output", content: { text: "hidden output candidate" } },
      { seq: 7, role: "assistant", content: { text: "delivered answer" } },
    ],
  };
  const turns = restoreTurns(snapshot, "conversation");
  expect(turns).toHaveLength(1);
  expect(turns[0]!.receipt?.state).toBe("read");
  const records = Object.values(turns[0]!.messages);
  expect(
    records
      .filter((record) => record.kind === "inference_item")
      .map((record) => record.data?.state),
  ).toEqual(["committed", "discarded", "closed", "streaming"]);
  expect(records.filter((record) => record.text === "delivered answer")).toHaveLength(1);
  expect(records.some((record) => record.text === "hidden output candidate")).toBe(false);
});
