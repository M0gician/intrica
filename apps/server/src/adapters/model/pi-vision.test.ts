import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ContextSnapshot } from "@intrica/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiRunner } from "./pi.js";
import type { FrozenOperation, ModelEvent } from "./types.js";

const ITEMS_JSON = JSON.stringify({ items: [{ title: "结论", text: "基于图片的结论。" }] });
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

type CapturedRequest = { url: string; body: string };

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
      captured.push({ url: req.url ?? "", body });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(`${sseChunk(ITEMS_JSON) + sseChunk("", true)}data: [DONE]\n\n`);
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

function imageSnapshot(): ContextSnapshot {
  return {
    snapshotVersion: 1,
    scope: { id: "root", kind: "group", title: "根", summary: "" },
    selection: ["n-img"],
    contextOnlyNodeIds: [],
    nodes: [
      {
        id: "n-img",
        kind: "image",
        title: "参考界面",
        assetId: "asset-1",
        assetVersion: 1,
        alt: "橙色样例图",
        revision: 1,
        containerPath: ["root"],
      },
    ],
    edges: [],
    includeDescendants: [],
    omittedNodeIds: [],
    instruction: "",
  };
}

function makeOp(): FrozenOperation {
  return {
    operationId: "op-vision",
    type: "expand",
    contextSnapshot: imageSnapshot(),
    placementMode: "sibling",
    instruction: "",
    resolveAsset: async () => ({ data: PNG_1PX, mime: "image/png" }),
  };
}

async function collect(runner: PiRunner): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of runner.run(makeOp(), new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

describe("PiRunner 图片输入", () => {
  it("supportsVision=true 时普通图片节点以 image block 进入模型请求", async () => {
    const runner = new PiRunner({
      provider: "custom",
      modelId: "vision-model",
      baseUrl: baseUrl(),
      apiKey: "k",
      supportsVision: true,
    });
    const events = await collect(runner);
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(captured).toHaveLength(1);
    const sent = JSON.parse(captured[0]!.body);
    const userMessage = sent.messages.findLast((m: { role: string }) => m.role === "user");
    const content = userMessage?.content;
    expect(Array.isArray(content)).toBe(true);
    const imageParts = (content as Array<{ type: string; image_url?: { url: string } }>).filter(
      (part) => part.type === "image_url",
    );
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0]!.image_url!.url).toContain("data:image/png;base64,");
    const textPart = (content as Array<{ type: string; text?: string }>).find(
      (part) => part.type === "text",
    );
    expect(textPart?.text).toContain("橙色样例图");
  });

  it("supportsVision=false 时只发送文本（图片以 alt 描述呈现）", async () => {
    const runner = new PiRunner({
      provider: "custom",
      modelId: "text-model",
      baseUrl: baseUrl(),
      apiKey: "k",
      supportsVision: false,
    });
    const events = await collect(runner);
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    const sent = JSON.parse(captured[0]!.body);
    const userMessage = sent.messages.findLast((m: { role: string }) => m.role === "user");
    const content = userMessage?.content;
    const parts = Array.isArray(content) ? content : [content];
    const hasImage = parts.some(
      (part: unknown) =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: string }).type === "image_url",
    );
    expect(hasImage).toBe(false);
    expect(JSON.stringify(content)).toContain("橙色样例图");
  });

  it("rejects a legacy mismatched PDF asset before sending an image request", async () => {
    const runner = new PiRunner({
      provider: "custom",
      modelId: "vision-model",
      baseUrl: baseUrl(),
      apiKey: "k",
      supportsVision: true,
    });
    const op = {
      ...makeOp(),
      resolveAsset: async () => ({ data: Buffer.from("%PDF-fixture"), mime: "application/pdf" }),
    };
    await expect(runner.run(op, new AbortController().signal).next()).rejects.toThrow(
      "Non-image asset",
    );
    expect(captured).toHaveLength(0);
  });
});
