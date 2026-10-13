import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { applyMessage } from "@intrica/contracts";
import type { FastifyReply } from "fastify";
import { Type } from "typebox";
import type { AppInstance } from "../app.js";
import type { Kernel } from "../composition.js";

const controllers = new WeakMap<object, Set<AbortController>>();
export function initializeStreams(app: AppInstance) {
  const active = new Set<AbortController>();
  controllers.set(app, active);
  app.addHook("preClose", async () => {
    for (const controller of active) controller.abort();
  });
}
export function createStream(
  app: AppInstance,
  reply: FastifyReply,
  source: (signal: AbortSignal) => AsyncGenerator<unknown>,
) {
  const active = controllers.get(app)!;
  const abort = new AbortController();
  active.add(abort);
  reply.raw.once("close", () => abort.abort());
  async function* lines() {
    try {
      for await (const item of source(abort.signal)) {
        if (abort.signal.aborted) return;
        yield `${JSON.stringify(item)}\n`;
      }
    } catch (_error) {
      if (!abort.signal.aborted)
        yield `${JSON.stringify({ type: "stream.error", message: "连接中断，请按游标重试" })}\n`;
    } finally {
      active!.delete(abort);
    }
  }
  return reply
    .type("application/x-ndjson")
    .header("Cache-Control", "no-store")
    .header("X-Accel-Buffering", "no")
    .send(Readable.from(lines(), { objectMode: false, highWaterMark: 64 * 1024 }));
}
export function registerStreams(app: AppInstance, k: Kernel) {
  for (const [path, topic] of [
    ["canvases", "canvas"],
    ["runs", "run"],
  ] as const)
    app.get(
      `/api/v2/${path}/:id/events`,
      {
        schema: {
          params: Type.Object({ id: Type.String() }),
          querystring: Type.Object({
            after: Type.Optional(Type.String({ pattern: "^[0-9]+$" })),
            format: Type.Optional(Type.Literal("delta")),
          }),
        },
      },
      async (req, reply) => {
        let cursor = req.query.after ?? "0";
        await k.events.validate(topic, req.params.id, cursor);
        return createStream(app, reply, async function* (signal) {
          let message =
            topic === "run" ? await k.events.messageAt(req.params.id, cursor) : undefined;
          if (req.query.format === "delta" && message?.streaming)
            yield { type: "stream.snapshot", seq: cursor, payload: message };
          let idle = 0;
          while (!signal.aborted) {
            const events = await k.events.read(topic, req.params.id, cursor);
            for (const event of events) {
              cursor = event.seq;
              if (event.type === "message" && req.query.format !== "delta") {
                message = applyMessage(message, event.payload);
                yield { ...event, payload: message };
              } else yield event;
            }
            if (!events.length && ++idle % 15 === 0) yield { type: "heartbeat" };
            await delay(events.length ? 10 : 500, undefined, { signal });
          }
        });
      },
    );
}
