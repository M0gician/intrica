import { expect, it } from "vitest";
import { addressedOutput } from "../fixtures/addressed-output.mjs";
import type { ResponsesWire } from "../fixtures/inference-wire.js";
import { inferenceHarness } from "./helpers/inference.js";

const h = inferenceHarness();
const begin = (wire: ResponsesWire) => {
  wire.response.writeHead(200, { "content-type": "text/event-stream" });
  wire.event("message_start", {
    message: {
      id: wire.id,
      type: "message",
      role: "assistant",
      model: "inference-fixture",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
};
const end = (wire: ResponsesWire, reason: string) => {
  wire.event("message_delta", {
    delta: { stop_reason: reason, stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  wire.event("message_stop", {});
  wire.response.end();
};

it("Anthropic signatures survive a complete protocol group and remain native thinking in the next request", async () => {
  const s = await h.session();
  Object.assign(s.run.frozen_input.model.config, {
    api: "anthropic-messages",
    provider: "anthropic",
  });
  const done = s.execute(),
    first = await h.nextWhile(done);
  begin(first);
  first.event("content_block_start", {
    index: 0,
    content_block: { type: "thinking", thinking: "", signature: "" },
  });
  first.event("content_block_delta", {
    index: 0,
    delta: { type: "thinking_delta", thinking: "SIGNED_REASONING" },
  });
  first.event("content_block_delta", {
    index: 0,
    delta: { type: "signature_delta", signature: "opaque-native-signature" },
  });
  first.event("content_block_stop", { index: 0 });
  first.event("content_block_start", {
    index: 1,
    content_block: { type: "tool_use", id: "tool_native", name: "read_canvas", input: {} },
  });
  first.event("content_block_delta", {
    index: 1,
    delta: { type: "input_json_delta", partial_json: "{}" },
  });
  first.event("content_block_stop", { index: 1 });
  end(first, "tool_use");
  const next = await h.nextWhile(done);
  const blocks = next.body.messages.flatMap((m: any) => m.content);
  expect(blocks.find((b: any) => b.type === "thinking")).toMatchObject({
    thinking: "SIGNED_REASONING",
    signature: "opaque-native-signature",
  });
  expect(
    blocks
      .filter((b: any) => b.type === "text")
      .some((b: any) => b.text.includes("SIGNED_REASONING")),
  ).toBe(false);
  expect(
    blocks.filter((b: any) => b.type === "tool_result" && b.tool_use_id === "tool_native"),
  ).toHaveLength(1);
  begin(next);
  next.event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  next.event("content_block_delta", {
    index: 0,
    delta: {
      type: "text_delta",
      text: addressedOutput(JSON.stringify(next.body), "Protocol verified"),
    },
  });
  next.event("content_block_stop", { index: 0 });
  end(next, "end_turn");
  await done;
});
