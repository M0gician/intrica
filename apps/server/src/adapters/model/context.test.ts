import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { summarizeContext } from "../../modules/context/summary.js";
import { parseContextSummary } from "../../modules/context/summary-contract.js";
import { createCanvasAgent } from "./agent.js";
import { checkpointMessages, contextUsage } from "./context.js";
import { resolveModel } from "./pi.js";

const config = { kind: "mock", streamDelayMs: 0, supportsVision: false } as const;
describe("Agent context", () => {
  it("uses the configured output ceiling and keeps room for the input context", () => {
    const resolved = resolveModel(
      {
        provider: "custom",
        modelId: "long-reasoning",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:1/v1",
        contextWindow: 128000,
        maxOutputTokens: 96000,
      },
      null,
      false,
    )!;
    expect(resolved.model.maxTokens).toBe(96000);
  });
  it("counts mock/zero usage as estimated and includes tools and instructions", async () => {
    const agent = createCanvasAgent(config, "context-test");
    await agent.prompt("保留这个任务");
    const info = contextUsage(agent, config);
    expect(info.tokens).toBeGreaterThan(0);
    expect(info.source).toBe("estimated");
    expect(info.safeLimit).toBeLessThan(info.contextWindow);
  });
  it("honors a configured endpoint context window and bounds output reservation", () => {
    const resolved = resolveModel(
      {
        provider: "custom",
        modelId: "m",
        api: "openai-completions",
        baseUrl: "http://localhost",
        contextWindow: 4096,
      },
      null,
      false,
    )!;
    expect(resolved.model.contextWindow).toBe(4096);
    expect(resolved.model.maxTokens).toBeLessThan(4096);
  });
  it("uses provider usage including cache tokens", async () => {
    const agent = createCanvasAgent(config, "usage");
    await agent.prompt("task");
    const last = agent.state.messages.at(-1)!;
    if (last.role !== "assistant") throw new Error("missing answer");
    last.usage = {
      ...last.usage,
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 10,
      totalTokens: 180,
    };
    const info = contextUsage(agent, config);
    expect(info.source).toBe("usage");
    expect(info.tokens).toBe(180);
    last.usage.totalTokens = 0;
    expect(contextUsage(agent, config).tokens).toBe(180);
  });
  it("does not persist image bytes in recoverable context; summarizer honors offload setting and cancellation", async () => {
    expect(
      JSON.stringify(
        checkpointMessages([
          {
            role: "user",
            content: [{ type: "image", data: "PRIVATE_IMAGE_BYTES", mimeType: "image/png" }],
            timestamp: 0,
          },
        ]),
      ),
    ).not.toContain("PRIVATE_IMAGE_BYTES");
    expect((await summarizeContext(config, [], false)).content.memory_text).toBeUndefined();
    expect((await summarizeContext(config, [], true)).content.memory_text).toBeTruthy();
    const abort = new AbortController();
    abort.abort();
    await expect(summarizeContext(config, [], true, abort.signal)).rejects.toThrow();
  });
});

it("summarizes through the configured transport, keeps the recent task, and rejects invalid summaries", async () => {
  let valid = true;
  let seen = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    expect(req.headers.authorization).toBe("Bearer context-test-key");
    expect(JSON.stringify(body.messages)).toContain("OLD_DECISION");
    seen++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ id: "summary", object: "chat.completion.chunk", model: "summary-test", choices: [{ index: 0, delta: { role: "assistant", content: valid ? JSON.stringify({ facts: ["保留关键决策"], decisions: [], completed_work: [], remaining_work: ["继续最后任务"], source_refs: ["s1"], memory_title: "关键决策", memory_text: "已经确认的结论。" }) : '{"summary":' }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const model = {
    kind: "pi" as const,
    provider: "custom",
    modelId: "summary-test",
    api: "openai-completions" as const,
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    apiKey: "context-test-key",
    contextWindow: 128000,
    thinkingLevel: "off" as const,
  };
  const messages = [
    { role: "user" as const, content: "OLD_DECISION ".repeat(18000), timestamp: 0 },
    { role: "user" as const, content: "最后任务", timestamp: 1 },
  ];
  try {
    const result = await summarizeContext(model, messages, true);
    expect(result.content.memory_title).toBe("关键决策");
    expect(result.retainedTail.at(-1)?.role).toBe("user");
    expect(JSON.stringify(result.retainedTail)).toContain("最后任务");
    expect(JSON.stringify(result.retainedTail)).not.toContain("OLD_DECISION");
    valid = false;
    await expect(summarizeContext(model, messages, true)).rejects.toThrow("checkpoint");
    expect(seen).toBe(2);
    expect(messages[0]!.content).toContain("OLD_DECISION");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("drops incomplete tool pairs when saving a stopped conversation", () => {
  const messages: any[] = [
    { role: "user", content: "原任务", timestamp: 0 },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "done", name: "read", arguments: {} },
        { type: "toolCall", id: "missing", name: "read", arguments: {} },
      ],
      stopReason: "toolUse",
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "done",
      toolName: "read",
      content: [{ type: "text", text: "读取成功" }],
      isError: false,
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "orphan",
      toolName: "read",
      content: [],
      isError: false,
      timestamp: 3,
    },
  ];
  const saved = JSON.stringify(checkpointMessages(messages));
  expect(saved).toContain("读取成功");
  expect(saved).not.toContain("missing");
  expect(saved).not.toContain("orphan");
});

it("rejects promises, arbitrary prose, stale source refs and truncated structured summaries", () => {
  const refs = new Set(["s1"]);
  const valid = {
    facts: ["Observed behavior"],
    decisions: [],
    completed_work: [],
    remaining_work: ["Continue"],
    source_refs: ["s1"],
  };
  expect(parseContextSummary(JSON.stringify(valid), refs)).toEqual(valid);
  expect(parseContextSummary("我会整理摘要，不继续执行原任务", refs)).toBeNull();
  expect(
    parseContextSummary(JSON.stringify({ ...valid, source_refs: ["other-conversation"] }), refs),
  ).toBeNull();
  expect(parseContextSummary(JSON.stringify(valid), refs, true)).toBeNull();
});
