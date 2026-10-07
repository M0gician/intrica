import { ApiError, newId } from "@intrica/client";
import type { ServerCapabilities, ServerInfo } from "@intrica/contracts";
import { compareStableVersions, GRAPH_PROTOCOL, MIN_SERVER_VERSION } from "@intrica/contracts";
import { useCallback, useEffect, useState } from "react";
import { createSessionConnection, type SessionConnection } from "../api/connection";
import i18n, { useTranslation } from "../i18n";
import { readServers, type ServerProfile, saveServers, serverOrigin } from "./preferences";

type Binding = {
  address: string;
  services: SessionConnection;
  profileId: string;
  server: ServerInfo | null;
  capabilities: ServerCapabilities | null;
};
export function useServerConnection() {
  const { t } = useTranslation();
  const desktop = window.intricaDesktop?.connection;
  const [binding, setBinding] = useState<Binding>(() => ({
    services: createSessionConnection("", "pending"),
    address: window.location.origin,
    profileId: "web",
    server: null,
    capabilities: null,
  }));
  const [phase, setPhase] = useState<"loading" | "login" | "ready" | "error" | "disconnected">(
      "loading",
    ),
    [error, setError] = useState(""),
    [token, setToken] = useState("");
  const [profiles, setProfiles] = useState<ServerProfile[]>(() => readServers());
  const establish = useCallback(
    async (services: SessionConnection, profileId: string, address = window.location.origin) => {
      setError("");
      try {
        await services.transport.request("/api/v2/session");
        const [server, capabilities] = await Promise.all([
          services.transport.request<ServerInfo>("/api/v2/server"),
          services.transport.request<ServerCapabilities>("/api/v2/capabilities"),
        ]);
        if (services.signal.aborted) return;
        const issue =
          compareStableVersions(server.version, MIN_SERVER_VERSION) < 0
            ? i18n.t("serverUpgradeRequired", { version: MIN_SERVER_VERSION })
            : server.apiVersion !== "v2" || server.graphProtocol !== GRAPH_PROTOCOL
              ? i18n.t("serverProtocolMismatch")
              : null;
        if (issue) {
          setBinding({ services, profileId, server, capabilities, address });
          setPhase("error");
          setError(issue);
          return;
        }
        const next = createSessionConnection(services.baseUrl, server.id, services.bindingId);
        setBinding({ services: next, profileId, server, capabilities, address });
        setPhase("ready");
        setToken("");
        services.dispose();
      } catch (e) {
        if (services.signal.aborted) return;
        if (e instanceof ApiError && e.status === 401) setPhase("login");
        else {
          setError((e as Error).message);
          setPhase("error");
        }
      }
    },
    [],
  );
  useEffect(() => {
    let current = true;
    const provisional = createSessionConnection("", "pending");
    setBinding((value) => ({ ...value, services: provisional }));
    void (async () => {
      try {
        if (desktop) {
          setProfiles(await desktop.list());
          const initial = await desktop.get();
          const services = createSessionConnection(initial.apiBase, "pending", initial.bindingId);
          if (!current) {
            services.dispose();
            return;
          }
          setBinding({
            services,
            profileId: initial.profileId,
            server: null,
            capabilities: null,
            address: initial.baseUrl,
          });
          await establish(services, initial.profileId, initial.baseUrl);
        } else await establish(provisional, "web");
      } catch (e) {
        if (current) {
          setError((e as Error).message);
          setPhase("error");
        }
      }
    })();
    return () => {
      current = false;
      provisional.dispose();
    };
  }, [establish, desktop]);
  useEffect(() => () => binding.services.dispose(), [binding.services]);
  const adoptDesktop = async (next: import("@intrica/contracts/desktop").DesktopConnection) => {
    const services = createSessionConnection(next.apiBase, "pending", next.bindingId);
    setPhase("loading");
    setBinding({
      services,
      profileId: next.profileId,
      address: next.baseUrl,
      server: null,
      capabilities: null,
    });
    await establish(services, next.profileId, next.baseUrl);
  };
  const currentWeb: ServerProfile = {
    id: "web",
    label: binding.server?.name ?? "Intrica",
    baseUrl: window.location.origin,
  };
  const disconnected = () => {
    setBinding({
      services: createSessionConnection("", "disconnected"),
      profileId: "",
      address: "",
      server: null,
      capabilities: null,
    });
    setPhase("disconnected");
    setError("");
  };
  const actions = {
    profiles: desktop
      ? profiles
      : [currentWeb, ...profiles.filter((p) => p.baseUrl !== window.location.origin)],
    activeId: phase === "ready" ? binding.profileId : null,
    desktop: Boolean(desktop),
    refresh: async () => {
      if (desktop) setProfiles(await desktop.list());
    },
    ...(desktop
      ? {
          inspect: (profile: ServerProfile) => desktop.inspect(profile.id),
          disconnect: async (profile: ServerProfile) => {
            await desktop.disconnect(profile.id);
            disconnected();
          },
          forgetToken: async (profile: ServerProfile) => {
            await desktop.forgetToken(profile.id);
            setProfiles(await desktop.list());
            if (profile.id === binding.profileId) {
              disconnected();
            }
          },
        }
      : {}),
    save: async (input: {
      id?: string;
      label: string;
      baseUrl: string;
      token?: string;
      rememberToken?: boolean;
    }) => {
      const baseUrl = serverOrigin(input.baseUrl);
      if (profiles.some((p) => p.baseUrl === baseUrl && p.id !== input.id))
        throw new Error("duplicateServer");
      if (desktop) {
        const saved = await desktop.save({ ...input, baseUrl });
        setProfiles(await desktop.list());
        if (
          saved.id === binding.profileId &&
          (saved.baseUrl !== binding.address || input.token !== undefined)
        ) {
          const next = await desktop.activate(saved.id);
          await adoptDesktop(next);
        }
        return saved;
      }
      const saved = { id: input.id ?? newId("server"), label: input.label, baseUrl };
      const next = [...profiles.filter((p) => p.id !== saved.id), saved];
      saveServers(next);
      setProfiles(next);
      return saved;
    },
    connect: async (profile: ServerProfile) => {
      if (!desktop) {
        window.location.assign(serverOrigin(profile.baseUrl));
        return;
      }
      const next = await desktop.activate(profile.id);
      await adoptDesktop(next);
    },
    remove: async (profile: ServerProfile) => {
      if (desktop) {
        if (profile.id === binding.profileId) {
          await desktop.disconnect(profile.id);
          disconnected();
        }
        await desktop.remove(profile.id);
        setProfiles(await desktop.list());
      } else {
        const next = profiles.filter((p) => p.id !== profile.id);
        saveServers(next);
        setProfiles(next);
      }
    },
  };
  const connect = () => establish(binding.services, binding.profileId, binding.address);
  const login = async () => {
    try {
      await binding.services.transport.json("POST", "/api/v2/session", { token });
      await connect();
    } catch (error) {
      setError(error instanceof ApiError && error.status === 401 ? t("tokenHint") : t("failed"));
    }
  };
  return { binding, phase, error, token, setToken, actions, connect, login };
}
