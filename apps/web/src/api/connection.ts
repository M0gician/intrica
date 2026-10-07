import { createTransport, newId, type Transport } from "@intrica/client";
import { createContext, useContext } from "react";
import { createActivityService } from "../data/activity";
import i18n from "../i18n";
import { errorMessage } from "../i18n/errors";
import { createApiClient } from "./client";
export function createSessionConnection(
  baseUrl = "",
  serverId = "local",
  bindingId: string = newId("binding"),
) {
  const abort = new AbortController();
  const activity = createActivityService(abort.signal);
  const transport = createTransport({
    baseUrl,
    signal: abort.signal,
    errorMessage,
    language: () => i18n.resolvedLanguage ?? "en",
  });
  const storageKey = (key: string) => `intrica:server:${serverId}:${key}`;
  const storage = {
    getItem: (key: string) => localStorage.getItem(storageKey(key)),
    setItem: (key: string, value: string) => localStorage.setItem(storageKey(key), value),
    removeItem: (key: string) => localStorage.removeItem(storageKey(key)),
  };
  const agentRequest = <T>(path: string, body?: unknown) =>
    transport.json<T>(
      body === undefined ? "GET" : "POST",
      `/api/v2/${path}`,
      body === undefined
        ? undefined
        : { ...(body as Record<string, unknown>), idempotencyKey: newId() },
    );
  const serverRequest = <T>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    signal?: AbortSignal,
  ) =>
    transport.request<T>(`/api/v2/workspace/${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  return {
    signal: abort.signal,
    baseUrl,
    serverId,
    bindingId,
    transport,
    activity,
    api: createApiClient(undefined, { transport }),
    storageKey,
    storage,
    agentRequest,
    serverRequest,
    controlCanvasAgents: (agentIds: string[], action: "start" | "stop") =>
      transport.json<{ count: number; agentIds: string[]; action: string }>(
        "POST",
        "/api/v2/canvas-agents/batch",
        { agentIds, action, idempotencyKey: newId() },
      ),
    assetUrl: (path: string) => (path.startsWith("/api/") ? `${baseUrl}${path}` : path),
    dispose: () => abort.abort(),
  };
}
export type SessionConnection = ReturnType<typeof createSessionConnection>;
// Immutable same-origin default permits independently rendered components in tests.
export const ConnectionServices = createContext<SessionConnection>(createSessionConnection());
export const useSessionConnection = () => useContext(ConnectionServices);
export type { Transport };
