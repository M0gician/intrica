import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

/** A test-owned compatible endpoint. The product uses its normal configuration and HTTP path. */
export async function createDefaultEndpoint() {
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ data: [{ id: "acceptance" }] }));
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      const text = (message) =>
        typeof message?.content === "string"
          ? message.content
          : (message?.content ?? [])
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("\n");
      const system = input.messages
        .filter((m) => ["system", "developer"].includes(m.role))
        .map(text)
        .join("\n");
      const latest = input.messages.at(-1);
      const turns = input.messages.filter((m) => m.role === "user").length;
      const id = randomUUID();
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (delta, finish_reason = null) =>
        res.write(
          `data: ${JSON.stringify({ id, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      if (
        input.tools?.some((t) => t.function?.name === "read_canvas") &&
        latest?.role === "user" &&
        !/^(?:后台工具 |Background tool )/.test(text(latest))
      ) {
        event(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call-${id}`,
                type: "function",
                function: { name: "read_canvas", arguments: "{}" },
              },
            ],
          },
          "tool_calls",
        );
      } else {
        let output = `模拟会话第 ${turns} 轮。\n${system}`;
        if (!input.tools?.length && system.includes('{"items"')) {
          const snapshot = JSON.parse(text(latest));
          const name =
            snapshot.nodes?.find((n) => n.id === snapshot.selection?.[0])?.title ?? "Evidence";
          const count = /exactly 1 item|恰好包含 1 项/.test(system) ? 1 : 2;
          output = JSON.stringify({
            items: Array.from({ length: count }, (_, i) => ({
              title: `${name} ${i + 1}`,
              text: `Controlled result ${i + 1} for ${name}.`,
            })),
          });
        }
        event({ role: "assistant" });
        for (let offset = 0; offset < output.length && !res.destroyed; offset += 80) {
          event({ content: output.slice(offset, offset + 80) });
          await delay(8);
        }
        event({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    env: {
      MODEL_KIND: "pi",
      MODEL_PROVIDER: "custom",
      MODEL_ID: "acceptance",
      MODEL_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      MODEL_API_KEY: "fixture",
      MODEL_SUPPORTS_VISION: "true",
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
