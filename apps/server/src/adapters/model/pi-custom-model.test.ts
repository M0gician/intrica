import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ContextSnapshot } from "@intrica/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiRunner } from "./pi.js";
import type { FrozenOperation, ModelEvent } from "./types.js";

const ITEMS_JSON = JSON.stringify({
  items: [
    { title: "可验证假设：假设", text: "围绕假设提出一条可验证假设。" },
    { title: "替代解释：假设", text: "给出假设的替代解释。" },
  ],
});

type CapturedRequest = { url: string; authorization: string | undefined; body: string };

let server: Server;
let captured: CapturedRequest[];

function sseChunk(content: string, finish = false): string {
  const chunk = {
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: 1,
    model: "stub",
    choices: [
      {
        index: 0,
        delta: content === "" && finish ? {} : { content },
        finish_reason: finish ? "stop" : null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

beforeEach(async () => {
  captured = [];
  server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      captured.push({
        url: req.url ?? "",
        authorization: req.headers.authorization,
        body,
      });
      if (
        JSON.parse(body).messages.some((message: { role: string }) => message.role === "developer")
      ) {
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: {
              message: "Invalid request: role 'developer' is not allowed",
              type: "invalid_request_error",
            },
          }),
        );
        return;
      }
      const pieces = ITEMS_JSON.match(/.{1,40}/gs) ?? [ITEMS_JSON];
      const payload = `${pieces.map((p) => sseChunk(p)).join("") + sseChunk("", true)}data: [DONE]\n\n`;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "close",
      });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function baseUrl(): string {
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/v1`;
}

function makeSnapshot(): ContextSnapshot {
  return {
    snapshotVersion: 1,
    scope: { id: "root", kind: "group", title: "根", summary: "" },
    selection: ["n-1"],
    contextOnlyNodeIds: [],
    nodes: [
      {
        id: "n-1",
        kind: "text",
        title: "假设",
        text: "正文",
        revision: 1,
        containerPath: ["root"],
      },
    ],
    edges: [],
    includeDescendants: [],
    omittedNodeIds: [],
    instruction: "提出一个可验证的下一步假设",
  };
}

function makeOp(): FrozenOperation {
  return {
    operationId: "op-stub",
    type: "expand",
    contextSnapshot: makeSnapshot(),
    placementMode: "sibling",
    instruction: "提出一个可验证的下一步假设",
  };
}

async function collect(runner: PiRunner): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of runner.run(makeOp(), new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

describe("PiRunner 自定义 baseUrl", () => {
  it("目录外模型 + baseUrl：走合成 openai-completions 模型打到自定义端点", async () => {
    const runner = new PiRunner({
      provider: "custom",
      modelId: "my-local-model",
      baseUrl: baseUrl(),
      apiKey: "test-key",
    });
    const events = await collect(runner);
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toEqual([]);
    const starts = events.filter((e) => e.type === "item.start");
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ itemIndex: 0, title: "可验证假设：假设" });
    expect(events.filter((e) => e.type === "item.complete")).toHaveLength(2);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("/v1/chat/completions");
    expect(captured[0]!.authorization).toBe("Bearer test-key");
    const sent = JSON.parse(captured[0]!.body);
    expect(sent.model).toBe("my-local-model");
    expect(sent.messages[0].role).toBe("system");
    expect(JSON.stringify(sent.messages)).toContain("假设");
  });

  it("目录模型 + baseUrl：克隆模型并把请求改发到自定义端点", async () => {
    const runner = new PiRunner({
      provider: "groq",
      modelId: "llama-3.3-70b-versatile",
      baseUrl: baseUrl(),
      apiKey: "proxy-key",
    });
    const events = await collect(runner);
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(events.filter((e) => e.type === "item.start")).toHaveLength(2);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("/v1/chat/completions");
    expect(captured[0]!.authorization).toBe("Bearer proxy-key");
    expect(JSON.parse(captured[0]!.body).model).toBe("llama-3.3-70b-versatile");
  });

  it("目录外模型且无 baseUrl：报 MODEL_NOT_FOUND", async () => {
    const runner = new PiRunner({ provider: "custom", modelId: "my-local-model" });
    const events = await collect(runner);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", code: "MODEL_NOT_FOUND" });
    expect(captured).toHaveLength(0);
  });
  it("GUI reasoning reaches the actual protocol for both generation and Agent turns", async () => {
    const config = {
      kind: "pi" as const,
      provider: "custom",
      modelId: "reasoner",
      api: "openai-completions" as const,
      baseUrl: baseUrl(),
      apiKey: "configured-key",
      reasoning: true,
      thinkingLevel: "high" as const,
    };
    expect((await collect(new PiRunner(config))).filter((e) => e.type === "error")).toEqual([]);
    expect(JSON.parse(captured[0]!.body).reasoning_effort).toBe("high");
    expect(JSON.parse(captured[0]!.body).messages[0].role).toBe("system");
    const { createCanvasAgent } = await import("./agent.js");
    const agent = createCanvasAgent(config, "test");
    await agent.prompt("hello");
    expect(JSON.parse(captured[1]!.body).reasoning_effort).toBe("high");
    expect(JSON.parse(captured[1]!.body).model).toBe("reasoner");
    expect(JSON.parse(captured[1]!.body).messages[0].role).toBe("system");
    expect(captured[1]!.authorization).toBe("Bearer configured-key");
    const off = createCanvasAgent({ ...config, thinkingLevel: "off" }, "test-off");
    await off.prompt("hello");
    expect(JSON.parse(captured[2]!.body).reasoning_effort).toBeUndefined();
    const legacy = createCanvasAgent(config, "role-ablation");
    legacy.state.model = {
      ...legacy.state.model,
      compat: { ...legacy.state.model.compat, supportsDeveloperRole: true },
    };
    await expect(legacy.prompt("hello")).rejects.toThrow("developer");
    expect(JSON.parse(captured[3]!.body)).toMatchObject({
      reasoning_effort: "high",
      messages: expect.arrayContaining([expect.objectContaining({ role: "developer" })]),
    });
    legacy.state.model = {
      ...legacy.state.model,
      compat: { ...legacy.state.model.compat, supportsDeveloperRole: false },
    };
    await legacy.prompt("hello");
    expect(legacy.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
    expect(JSON.parse(captured[4]!.body)).toMatchObject({
      reasoning_effort: "high",
      messages: expect.arrayContaining([expect.objectContaining({ role: "system" })]),
    });
  });
  it("endpoint-declared max effort reaches the wire without being clamped to high", async () => {
    const events = await collect(
      new PiRunner({
        provider: "custom",
        api: "openai-completions",
        modelId: "proxy-model",
        baseUrl: baseUrl(),
        apiKey: "test",
        reasoning: true,
        thinkingLevel: "max",
        thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
      }),
    );
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(JSON.parse(captured[0]!.body).reasoning_effort).toBe("max");
  });
});
