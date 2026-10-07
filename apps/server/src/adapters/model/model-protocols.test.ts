import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createCanvasAgent } from "./agent.js";

let server: Server;
let baseUrl: string;
let captured: any[];
const frame = (value: unknown, name?: string) =>
  `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(value)}\n\n`;
beforeEach(async () => {
  captured = [];
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    captured.push({ body, path: request.url, headers: request.headers });
    if (body.input?.some((message: { role?: string }) => message.role === "developer")) {
      response
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { message: "role 'developer' is not allowed" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (request.url?.includes("streamGenerateContent")) {
      response.end(
        frame({
          candidates: [
            { content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP", index: 0 },
          ],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
        }),
      );
    } else if (request.url?.includes("messages")) {
      response.write(
        frame(
          {
            type: "message_start",
            message: {
              id: "m1",
              type: "message",
              role: "assistant",
              content: [],
              model: body.model,
              usage: { input_tokens: 3, output_tokens: 0 },
            },
          },
          "message_start",
        ),
      );
      response.write(
        frame(
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          "content_block_start",
        ),
      );
      response.write(
        frame(
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
          "content_block_delta",
        ),
      );
      response.write(frame({ type: "content_block_stop", index: 0 }, "content_block_stop"));
      response.write(
        frame(
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 1 },
          },
          "message_delta",
        ),
      );
      response.end(frame({ type: "message_stop" }, "message_stop"));
    } else {
      response.write(
        frame({
          type: "response.created",
          response: { id: "r1", status: "in_progress", output: [] },
        }),
      );
      response.write(
        frame({
          type: "response.output_item.added",
          output_index: 0,
          item: { id: "m1", type: "message", role: "assistant", content: [] },
        }),
      );
      response.write(
        frame({
          type: "response.content_part.added",
          output_index: 0,
          item_id: "m1",
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }),
      );
      response.write(
        frame({
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          item_id: "m1",
          delta: "OK",
        }),
      );
      response.write(
        frame({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: "m1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "OK", annotations: [] }],
          },
        }),
      );
      response.end(
        frame({
          type: "response.completed",
          response: {
            id: "r1",
            status: "completed",
            usage: {
              input_tokens: 3,
              output_tokens: 1,
              total_tokens: 4,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
it("OpenAI Responses sends selected effort through the explicit protocol", async () => {
  const agent = createCanvasAgent(
    {
      kind: "pi",
      provider: "custom",
      modelId: "custom-reasoner",
      baseUrl: `${baseUrl}/v1`,
      api: "openai-responses",
      apiKey: "fixture-key",
      reasoning: true,
      thinkingLevel: "high",
    },
    "responses",
  );
  await agent.prompt("hello");
  expect(captured[0].path).toBe("/v1/responses");
  expect(captured[0].body.input[0].role).toBe("system");
  expect(captured[0].body).toMatchObject({
    model: "custom-reasoner",
    reasoning: { effort: "high" },
  });
  expect(agent.state.messages.at(-1)).toMatchObject({
    role: "assistant",
    stopReason: "stop",
    content: [expect.objectContaining({ type: "text", text: "OK" })],
  });
});
it("Anthropic Messages uses a thinking budget and x-api-key", async () => {
  const agent = createCanvasAgent(
    {
      kind: "pi",
      provider: "custom",
      modelId: "custom-claude",
      baseUrl,
      api: "anthropic-messages",
      apiKey: "fixture-key",
      reasoning: true,
      thinkingLevel: "low",
    },
    "anthropic",
  );
  await agent.prompt("hello");
  expect(captured[0].path).toBe("/v1/messages?beta=true");
  expect(captured[0].headers["x-api-key"]).toBe("fixture-key");
  expect(captured[0].body.thinking).toMatchObject({
    type: "enabled",
    budget_tokens: expect.any(Number),
  });
  expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
});
it("Google Gemini uses its own endpoint and thinking configuration", async () => {
  const agent = createCanvasAgent(
    {
      kind: "pi",
      provider: "custom",
      modelId: "gemini-2.5-flash",
      baseUrl,
      api: "google-generative-ai",
      apiKey: "fixture-key",
      reasoning: true,
      thinkingLevel: "low",
    },
    "google",
  );
  await agent.prompt("hello");
  expect(captured[0].path).toContain("models/gemini-2.5-flash:streamGenerateContent");
  expect(captured[0].body.generationConfig.thinkingConfig.thinkingBudget).toBeGreaterThan(0);
  expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
});
