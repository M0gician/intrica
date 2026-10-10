import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export class ResponsesWire {
  private sequence = 0;
  constructor(
    readonly body: any,
    readonly response: ServerResponse,
    readonly id: string,
  ) {}
  event(type: string, fields: Record<string, unknown>) {
    this.response.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.sequence++, ...fields })}\n\n`,
    );
  }
  start() {
    this.response.writeHead(200, { "content-type": "text/event-stream" });
    this.event("response.created", {
      response: { id: this.id, status: "in_progress", output: [] },
    });
  }
  item(item: Record<string, unknown>, index: number, complete = true) {
    this.event("response.output_item.added", {
      output_index: index,
      item: { ...item, status: "in_progress" },
    });
    if (complete)
      this.event("response.output_item.done", {
        output_index: index,
        item: { ...item, status: "completed" },
      });
  }
  finish(output: unknown[] = []) {
    this.event("response.completed", {
      response: {
        id: this.id,
        status: "completed",
        output,
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      },
    });
    this.response.end();
  }
  answer(text: string) {
    const item = {
      type: "message",
      id: `${this.id}_message`,
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    this.item(item, 0);
    this.finish([item]);
  }
}

export async function responseEndpoint() {
  const pending: ResponsesWire[] = [],
    consumers: ReturnType<typeof deferred<ResponsesWire>>[] = [];
  let ordinal = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const wire = new ResponsesWire(JSON.parse(body), response, `resp_${++ordinal}`);
    const consumer = consumers.shift();
    if (consumer) consumer.resolve(wire);
    else pending.push(wire);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    get requests() {
      return ordinal;
    },
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    next() {
      const existing = pending.shift();
      if (existing) return Promise.resolve(existing);
      const next = deferred<ResponsesWire>();
      consumers.push(next);
      return next.promise;
    },
    closeConnections: () => server.closeAllConnections(),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function reasoning(id: string, encrypted?: string) {
  return {
    type: "reasoning",
    id,
    summary: [{ type: "summary_text", text: `Summary ${id}` }],
    ...(encrypted ? { encrypted_content: encrypted } : {}),
  };
}
export function call(id: string, name: string, args: object = {}) {
  return {
    type: "function_call",
    id: `fc_${id}`,
    call_id: `call_${id}`,
    name,
    arguments: JSON.stringify(args),
  };
}
