import type { ConflictDetail, ErrorCode } from "@intrica/contracts";
export class ApiError extends Error {
  readonly serverMessage: string;
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details: ConflictDetail[] = [],
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.serverMessage = message;
    this.name = "ApiError";
  }
}
export const newId = (prefix = "id") =>
  `${prefix}-${typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, "0")).join("")}`;
export type TransportOptions = {
  language?: () => string;
  errorMessage?: (error: ApiError) => string;
  signal?: AbortSignal;
  baseUrl?: string;
  token?: string;
  authProvider?: () => string | undefined | Promise<string | undefined>;
};
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type StreamHandle = { cursor: string; close(): void };
export type StreamRecord = { seq: string; type: string; payload: any; attemptId?: string | null };
export async function parseError(response: Response): Promise<ApiError> {
  const data = await response.json().catch(() => null);
  return new ApiError(
    response.status,
    data?.error?.code ?? "INTERNAL",
    data?.error?.message ?? `Server 请求失败（HTTP ${response.status}）`,
    data?.error?.details ?? [],
    data?.error?.upstreamStatus,
  );
}
export async function readJsonLines(
  response: Response,
  onEvent: (event: any) => void | Promise<void>,
) {
  if (!response.ok) throw await parseError(response);
  if (!response.body) throw new Error("Server 未提供事件流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 2 * 1024 * 1024) throw new Error("事件超过大小限制");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) await onEvent(JSON.parse(line));
        newline = buffer.indexOf("\n");
      }
      if (done) {
        if (buffer.trim()) await onEvent(JSON.parse(buffer));
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function createTransport(
  options: TransportOptions = {},
  fetchImpl: FetchLike = fetch.bind(globalThis),
) {
  const raw = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (options.language) headers.set("Accept-Language", options.language());
    const token = options.authProvider ? await options.authProvider() : options.token;
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetchImpl(`${options.baseUrl?.replace(/\/$/, "") ?? ""}${path}`, {
      ...init,
      headers,
      ...(options.signal
        ? { signal: init.signal ? AbortSignal.any([options.signal, init.signal]) : options.signal }
        : {}),
      credentials: "include",
    });
  };
  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await raw(path, init);
    if (!response.ok) {
      const error = await parseError(response);
      if (options.errorMessage) error.message = options.errorMessage(error);
      throw error;
    }
    return response.json() as Promise<T>;
  };
  const json = <T>(method: string, path: string, body?: unknown) =>
    request<T>(path, {
      method,
      ...(body !== undefined
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
  const subscribe = (
    path: string,
    after: string,
    callbacks: {
      onEvent: (event: StreamRecord) => void | Promise<void>;
      onReset: () => void;
      onError?: (error: unknown) => void;
    },
  ): StreamHandle => {
    const abort = new AbortController();
    const handle: StreamHandle = { cursor: after, close: () => abort.abort() };
    void (async () => {
      let failures = 0;
      while (!abort.signal.aborted && !options.signal?.aborted) {
        try {
          const response = await raw(
            `${path}${path.includes("?") ? "&" : "?"}after=${encodeURIComponent(handle.cursor)}`,
            {
              signal: abort.signal,
            },
          );
          if (response.status === 410) {
            callbacks.onReset();
            return;
          }
          await readJsonLines(response, async (record) => {
            if (abort.signal.aborted || options.signal?.aborted) return;
            if (record.type === "heartbeat") return;
            if (record.type === "stream.error") throw new Error(record.message);
            if (record.type === "stream.snapshot" && record.seq === handle.cursor) {
              await callbacks.onEvent(record);
              return;
            }
            if (typeof record.seq !== "string" || !/^\d+$/.test(record.seq)) return;
            const incoming = BigInt(record.seq),
              current = BigInt(handle.cursor);
            if (incoming <= current) return;
            if (incoming !== current + 1n) {
              callbacks.onReset();
              abort.abort();
              return;
            }
            await callbacks.onEvent(record);
            handle.cursor = record.seq;
            failures = 0;
          });
          if (!abort.signal.aborted) throw new Error("事件流已断开");
        } catch (error) {
          if (abort.signal.aborted || options.signal?.aborted) return;
          if (error instanceof ApiError && [401, 403].includes(error.status)) {
            callbacks.onError?.(error);
            return;
          }
          if (++failures > 8) {
            callbacks.onError?.(error);
            return;
          }
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              abort.signal.removeEventListener("abort", finish);
              resolve();
            };
            const timer = setTimeout(finish, Math.min(500 * 2 ** (failures - 1), 15000));
            abort.signal.addEventListener("abort", finish, { once: true });
          });
        }
      }
    })();
    return handle;
  };
  return { fetch: raw, request, json, subscribe };
}
export type Transport = ReturnType<typeof createTransport>;
