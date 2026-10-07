import type { ServerCapabilities, ServerInfo } from "@intrica/contracts";
import { GRAPH_PROTOCOL } from "@intrica/contracts";
import { serverOrigin } from "./server-address.js";
import { createTransport } from "./transport.js";

export { serverOrigin };

export type AuthProvider = () => string | undefined | Promise<string | undefined>;

export type ConnectionProfile = {
  baseUrl: string;
  token?: string;
  authProvider?: AuthProvider;
};

export type ConnectionState = {
  profile: ConnectionProfile;
  server: ServerInfo | null;
  capabilities: ServerCapabilities | null;
  checkedAt: number | null;
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createConnection(
  profile: ConnectionProfile,
  fetchImpl: FetchLike = fetch.bind(globalThis),
) {
  const normalized: ConnectionProfile = { ...profile, baseUrl: serverOrigin(profile.baseUrl) };
  let state: ConnectionState = {
    profile: normalized,
    server: null,
    capabilities: null,
    checkedAt: null,
  };

  const transport = createTransport(normalized, fetchImpl);
  const request = transport.request;

  async function probe(): Promise<ConnectionState> {
    const [server, capabilities] = await Promise.all([
      request<ServerInfo>("/api/v2/server"),
      request<ServerCapabilities>("/api/v2/capabilities"),
    ]);
    if (server.apiVersion !== "v2" || server.graphProtocol !== GRAPH_PROTOCOL)
      throw new Error("Client and server protocols differ. Update both to the same release.");
    state = { ...state, server, capabilities, checkedAt: Date.now() };
    return state;
  }

  return {
    profile: normalized,
    request,
    probe,
    state: () => state,
  };
}

export type Connection = ReturnType<typeof createConnection>;

export {
  ApiError,
  createTransport,
  newId,
  readJsonLines,
  type StreamHandle,
  type StreamRecord,
  type Transport,
} from "./transport.js";
