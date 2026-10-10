import { applyMessage, type StreamMessage } from "@intrica/contracts";
import { expect, it } from "vitest";
import { MessageStream } from "./message-stream.js";

it("reduces long-stream storage while preserving Unicode, duplicate delivery and snapshot recovery", async () => {
  const events: StreamMessage[] = [],
    originals: StreamMessage[] = [];
  const stream = new MessageStream("same-message", async (event) => {
    events.push(event);
  });
  let text = "",
    thinking = "";
  for (let i = 0; i < 240; i++) {
    text += `汉字 λ 🐈 ${i}\n`.repeat(10);
    thinking += `Step ${i}. `;
    originals.push({ id: "same-message", text, thinking });
    await stream.write(text, thinking, true, i * 250);
  }
  await stream.write(text, thinking, false, 60000);
  let restored: StreamMessage | undefined;
  for (const event of events) {
    restored = applyMessage(restored, event);
    restored = applyMessage(restored, event);
  }
  expect(restored).toMatchObject({ text, thinking, streaming: false });
  expect(Buffer.byteLength(JSON.stringify(events))).toBeLessThan(
    Buffer.byteLength(JSON.stringify(originals)) / 5,
  );
  const snapshotIndex = events.findIndex((e, i) => i > 0 && !e.delta);
  let reconnected: StreamMessage | undefined;
  for (const event of events.slice(snapshotIndex)) reconnected = applyMessage(reconnected, event);
  expect(reconnected).toEqual(restored);
  expect(() => applyMessage(events[0], events[2]!)).toThrow("MESSAGE_RESET_REQUIRED");
  expect(applyMessage(undefined, { id: "old-format", text: "legacy", thinking: "" }).text).toBe(
    "legacy",
  );
});
