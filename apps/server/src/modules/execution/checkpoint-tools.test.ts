import { expect, it } from "vitest";
import { openCheckpointCalls } from "./checkpoint-tools.js";

it("keeps unresolved calls in checkpoint order and scopes reused IDs to each assistant turn", () => {
  const call = (id: string) => ({ type: "toolCall", id, name: "read", arguments: { path: id } });
  const checkpoint = [
    { role: "toolResult", toolCallId: "old" },
    { role: "assistant", content: [call("old"), call("answered")] },
    { role: "user", content: "continue" },
    { role: "toolResult", toolCallId: "answered" },
    { role: "assistant", content: [call("answered"), call("later")] },
    { role: "assistant", content: "no tool calls" },
    { role: "toolResult", toolCallId: "later" },
    { role: "assistant", content: [call("final"), call("closed")] },
    { role: "toolResult", toolCallId: "closed" },
  ];
  expect(openCheckpointCalls(checkpoint)).toEqual([
    { index: 1, id: "old", name: "read", arguments: { path: "old" } },
    { index: 4, id: "answered", name: "read", arguments: { path: "answered" } },
    { index: 4, id: "later", name: "read", arguments: { path: "later" } },
    { index: 7, id: "final", name: "read", arguments: { path: "final" } },
  ]);
});
