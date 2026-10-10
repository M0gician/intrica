import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { providerHistory } from "../../modules/inference/context-projection.js";
import { retryDecision } from "../../modules/inference/retry-policy.js";
import { createCanvasAgent } from "./agent.js";
import { checkpointMessages } from "./context.js";
import { PiEvents } from "./pi-events.js";
import { streamTurn } from "./stream-turn.js";

const base = createCanvasAgent({ kind: "mock" }, "fixture").state.model;
const model = (api: Api): Model<Api> => ({ ...base, api, provider: "fixture", id: "fixture" });
const message = (
  content: AssistantMessage["content"],
  api: Api = "openai-responses",
): AssistantMessage => ({
  role: "assistant",
  content,
  api,
  provider: "fixture",
  model: "fixture",
  timestamp: 0,
  stopReason: "stop",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const reasoning = (encrypted?: string) => {
  const nativeItem = {
    type: "reasoning",
    id: "rs_native",
    status: "completed",
    summary: [{ type: "summary_text", text: "Visible summary" }],
    ...(encrypted ? { encrypted_content: encrypted } : {}),
  };
  return {
    type: "thinking" as const,
    thinking: "Visible summary",
    thinkingSignature: JSON.stringify(nativeItem),
    nativeItem,
  };
};
const textBlock = (text: string) => ({
  type: "text" as const,
  text,
  nativeItem: {
    type: "message",
    id: "msg_native",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
  },
});

afterEach(() => vi.useRealTimers());

it.each(["openai-responses", "azure-openai-responses", "openai-codex-responses"])(
  "%s commits a replayable group and keeps unfinished blocks outside history",
  (api) => {
    const projection = new PiEvents(model(api));
    const partial = message([reasoning("opaque-native-continuation")], api);
    expect(
      projection
        .events({ type: "thinking_end", contentIndex: 0, content: "Visible summary", partial })
        .some((e) => e.type === "item.continuation_ready"),
    ).toBe(false);
    partial.content.push({
      type: "toolCall",
      id: "call_native|fc_native",
      name: "read",
      arguments: { target: { kind: "path", path: "/fixture" } },
      nativeItem: {
        type: "function_call",
        id: "fc_native",
        call_id: "call_native",
        name: "read",
        status: "completed",
        arguments: '{"target":{"kind":"path","path":"/fixture"}}',
      },
    });
    const events = projection.events({
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: partial.content[1] as any,
      partial,
    });
    const ready = events.find((e) => e.type === "item.continuation_ready")!;
    expect(ready).toMatchObject({ indexes: [0, 1], message: { stopReason: "toolUse" } });
    if (ready.type !== "item.continuation_ready") throw new Error("missing group");
    partial.content.push({ type: "thinking", thinking: "unfinished" });
    projection.events({ type: "thinking_delta", contentIndex: 2, delta: "unfinished", partial });
    expect(ready.message.content).toHaveLength(2);
    expect(JSON.parse((ready.message.content[0] as any).thinkingSignature).encrypted_content).toBe(
      "opaque-native-continuation",
    );
    expect(
      projection.events({
        type: "error",
        reason: "aborted",
        error: { ...partial, stopReason: "aborted" },
      }),
    ).toEqual([{ type: "request.ended", reason: "aborted" }]);
  },
);

it("Azure content closure waits for encrypted continuation supplied at response completion", () => {
  const projection = new PiEvents(model("azure-openai-responses"));
  const partial = message([reasoning(), textBlock("A complete output")], "azure-openai-responses");
  for (const [type, contentIndex] of [
    ["thinking_end", 0],
    ["text_end", 1],
  ] as const)
    expect(
      projection
        .events({ type, contentIndex, content: "closed", partial })
        .some((e) => e.type === "item.continuation_ready"),
    ).toBe(false);
  partial.content[0] = reasoning("late-encrypted-content");
  const ready = projection
    .events({ type: "done", reason: "stop", message: partial })
    .find((e) => e.type === "item.continuation_ready");
  expect(ready).toMatchObject({ indexes: [0, 1] });
  expect(JSON.stringify(ready)).toContain("late-encrypted-content");
});

it("Anthropic requires the native signature and commits the complete protocol group", () => {
  const projection = new PiEvents(model("anthropic-messages"));
  const draft = message(
    [
      { type: "thinking", thinking: "summary" },
      { type: "text", text: "answer" },
    ],
    "anthropic-messages",
  );
  const incomplete = projection.events({ type: "done", reason: "stop", message: draft });
  expect(incomplete.some((e) => e.type === "item.continuation_ready")).toBe(false);
  (draft.content[0] as any).thinkingSignature = "opaque-signature";
  const complete = projection.events({ type: "done", reason: "stop", message: draft });
  expect(JSON.stringify(complete.find((e) => e.type === "item.continuation_ready"))).toContain(
    "opaque-signature",
  );
});

it("bounded drain ends an unresponsive provider and ignores events after sealing", async () => {
  vi.useFakeTimers();
  const cutover = new AbortController(),
    source = createAssistantMessageEventStream();
  const events: unknown[] = [];
  const done = streamTurn(
    () => source,
    model("openai-responses"),
    { messages: [] },
    {},
    undefined,
    {
      event: async (event) => {
        events.push(event);
      },
      beforeStart: async () => {},
      beforeDispatch: async () => {},
      cutover: cutover.signal,
      settleMs: 25,
      idleMs: 1000,
    },
  );
  const failed = expect(done).rejects.toMatchObject({ code: "EXPEDITED" });
  await vi.advanceTimersByTimeAsync(0);
  cutover.abort();
  await vi.advanceTimersByTimeAsync(25);
  await failed;
  source.push({ type: "done", reason: "stop", message: message([reasoning("late")]) });
  await vi.advanceTimersByTimeAsync(0);
  expect(events).toEqual([]);
});

it("partial reasoning stays diagnostic and cross-model replay preserves tool pairing", () => {
  const partial = {
    ...message([reasoning("secret"), { type: "text", text: "draft" }]),
    stopReason: "aborted" as const,
  };
  expect(checkpointMessages([partial])).toEqual([]);
  const full = message([reasoning("signature"), { type: "text", text: "verified" }]);
  const changed = providerHistory([full], { ...model("anthropic-messages"), provider: "another" });
  expect(changed).toMatchObject([{ content: [{ type: "text", text: "verified" }] }]);
  expect(() =>
    providerHistory(
      [message([{ type: "toolCall", id: "call", name: "read", arguments: {} }])],
      model("openai-responses"),
    ),
  ).toThrow("回执");
});

it("retry policy distinguishes fresh attempts, committed continuations, cutovers and permanent failures", () => {
  expect(retryDecision(new Error("ETIMEDOUT"), 0, false, false)).toBe("retry");
  expect(retryDecision(new Error("ETIMEDOUT"), 0, true, false)).toBe("continue");
  expect(retryDecision(new Error("ETIMEDOUT"), 0, true, true)).toBe("cutover");
  expect(retryDecision(new Error("ETIMEDOUT"), 2, true, false)).toBe("fail");
  expect(retryDecision(new Error("401 unauthorized"), 0, false, false)).toBe("fail");
});
