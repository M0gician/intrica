import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createCanvasAgent } from "./agent.js";
import {
  checkpointMessages,
  contextUsage,
  parseContextSummary,
  summarizeContext,
} from "./context.js";
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
    expect((await summarizeContext(config, [], false)).memory).toBeUndefined();
    expect((await summarizeContext(config, [], true)).memory?.text).toBeTruthy();
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
      `data: ${JSON.stringify({ id: "summary", object: "chat.completion.chunk", model: "summary-test", choices: [{ index: 0, delta: { role: "assistant", content: valid ? JSON.stringify({ summary: "保留关键决策，继续最后任务。", memory: { title: "关键决策", text: "已经确认的结论。" } }) : '{"summary":' }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
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
    expect(result.memory?.title).toBe("关键决策");
    expect(result.retainedTail.at(-1)?.role).toBe("user");
    expect(JSON.stringify(result.retainedTail)).toContain("最后任务");
    expect(JSON.stringify(result.retainedTail)).not.toContain("OLD_DECISION");
    valid = false;
    await expect(summarizeContext(model, messages, true)).rejects.toThrow("原会话已保留");
    expect(seen).toBe(3);
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

it("accepts Markdown and wrapped JSON without making an optional malformed note block compaction", () => {
  expect(parseContextSummary("## 当前任务\n已核对接口和依赖；下一步检查部署文档。")).toMatchObject({
    summary: expect.stringContaining("当前任务"),
  });
  expect(
    parseContextSummary('整理如下：\n```json\n{"summary":"继续核查","memory":{"text":123}}\n```'),
  ).toEqual({ summary: "继续核查" });
  expect(parseContextSummary('{"summary":')).toBeNull();
  expect(parseContextSummary("这一段被供应商截断", true)).toBeNull();
});

it("repairs an incomplete JSON response once with Markdown and preserves the original task", async () => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
    }
    const content =
      ++calls === 1 ? '{"summary":' : "## 当前任务\n保留原先决策，接下来完成最后的检查。";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ id: "repair", object: "chat.completion.chunk", model: "repair", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const summary = await summarizeContext(
      {
        kind: "pi",
        provider: "custom",
        modelId: "repair",
        api: "openai-completions",
        apiKey: "test",
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        thinkingLevel: "off",
      },
      [
        { role: "user", content: "此前的任务", timestamp: 0 },
        { role: "user", content: "继续检查", timestamp: 1 },
      ],
      true,
    );
    expect(calls).toBe(2);
    expect(summary.summary).toContain("完成最后");
    expect(summary.memory).toBeUndefined();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
