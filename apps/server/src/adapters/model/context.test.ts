import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { summaryMessage } from "../../modules/context/messages.js";
import { summarizeContext } from "../../modules/context/summary.js";
import { validateContextSummary } from "../../modules/context/summary-contract.js";
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
    const agent = createCanvasAgent(config);
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
    const agent = createCanvasAgent(config);
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
  it("does not persist image bytes in recoverable context; summarizer preserves archive evidence and honors cancellation", async () => {
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
    const history = [{ role: "user" as const, content: "Keep this decision", timestamp: 0 }];
    const summary = await summarizeContext(config, history);
    expect(summary.content.text).toBeTruthy();
    expect(summary.sourceMessages).toEqual(history);
    const abort = new AbortController();
    abort.abort();
    await expect(summarizeContext(config, [], abort.signal)).rejects.toThrow();
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
      `data: ${JSON.stringify({ id: "summary", object: "chat.completion.chunk", model: "summary-test", choices: [{ index: 0, delta: { role: "assistant", content: valid ? "已确认关键决策。继续最后任务，必要时查询归档来源。" : "incomplete handoff" }, finish_reason: valid ? "stop" : "length" }] })}\n\ndata: [DONE]\n\n`,
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
    await expect(summarizeContext(model, [])).rejects.toMatchObject({
      code: "CONTEXT_EMPTY_SOURCE",
    });
    expect(seen).toBe(0);
    const result = await summarizeContext(model, messages);
    expect(result.content.text).toContain("已确认关键决策");
    expect(result.sourceMessages[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("OLD_DECISION"),
    });
    expect(result.retainedTail.at(-1)?.role).toBe("user");
    expect(JSON.stringify(result.retainedTail)).toContain("最后任务");
    expect(JSON.stringify(result.retainedTail)).not.toContain("OLD_DECISION");
    valid = false;
    await expect(summarizeContext(model, messages)).rejects.toThrow("CONTEXT_SUMMARY_INVALID");
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

it("preserves handoff text without treating its prose or JSON layout as semantic validation", () => {
  const model = createCanvasAgent(config);
  for (const text of [
    "I will retain the current plan: deployment is blocked pending approval; the review remains open.",
    "我会继续沿用已确认的方案：检查已通过，部署仍需授权。",
    '{"summary":"Review passed; deployment still requires approval.","references":["audit.md"]}',
  ]) {
    const message = summaryMessage(model.state.model, "test", { text }, "en");
    if (message.role !== "assistant") throw new Error("fixture");
    message.content = [{ type: "text", text }];
    expect(validateContextSummary(message)).toEqual({ text });
  }
});

it("passes complete previous handoffs through 30 real transport compactions with distinct stable source references", async () => {
  const handoff = `${"Verified detail. ".repeat(400)}MIDDLE_COMPLETED_AND_UNFINISHED_WORK${"Preserved decision. ".repeat(400)}`;
  const inputs: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    inputs.push(JSON.stringify(body.messages));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ id: "handoff", model: "summary-test", choices: [{ index: 0, delta: { role: "assistant", content: `${handoff}\nGeneration ${inputs.length}` }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = {
    kind: "pi" as const,
    provider: "custom",
    modelId: "summary-test",
    api: "openai-completions" as const,
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    apiKey: "fixture",
    contextWindow: 128000,
    thinkingLevel: "off" as const,
  };
  const model = createCanvasAgent(config);
  let prior = summaryMessage(model.state.model, "initial", { text: handoff }, "en");
  const references = new Set<string>();
  try {
    for (let index = 0; index < 30; index++) {
      const result = await summarizeContext(config, [
        prior,
        { role: "user", content: "Continue verifying the remaining work", timestamp: index },
      ]);
      expect(inputs[index]).toContain("MIDDLE_COMPLETED_AND_UNFINISHED_WORK");
      expect(inputs[index]).toContain("Verified detail. ".repeat(400));
      expect(inputs[index]).toContain("Preserved decision. ".repeat(400));
      expect(result.sourceMessages[0]).toEqual(prior);
      expect(result.sources[0]?.ref).toBe(`context:${result.id}:0`);
      expect(references.has(result.sources[0]!.ref)).toBe(false);
      references.add(result.sources[0]!.ref);
      prior = summaryMessage(model.state.model, result.id, result.content, "en");
    }
    expect(inputs).toHaveLength(30);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
