import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serverOrigin } from "@intrica/client";

/** Credentials and active targets stay in the main process. No generic fetch IPC. */
export async function createConnections({
  userData,
  safeStorage,
  localUrl,
  localToken,
  fetchImpl = fetch,
  resolveSsh,
  releaseSsh,
}) {
  const path = join(userData, "connections.json");
  const records = new Map();
  const tokens = new Map();
  const bindings = new Map();
  let active = null;
  const secure = () =>
    safeStorage.isEncryptionAvailable() &&
    safeStorage.getSelectedStorageBackend?.() !== "basic_text";
  try {
    for (const record of JSON.parse(await readFile(path, "utf8"))) {
      if (typeof record.id === "string" && typeof record.label === "string") {
        record.baseUrl = serverOrigin(record.baseUrl);
        if (record.sshAlias) delete record.encryptedToken;
        records.set(record.id, record);
      }
    }
  } catch {}
  records.set("local", { id: "local", label: "Local", baseUrl: localUrl ?? "", local: true });
  tokens.set("local", localToken);
  const publicRecord = (record) => ({
    id: record.id,
    label: record.label,
    baseUrl: record.baseUrl,
    ...(record.expectedServerId ? { expectedServerId: record.expectedServerId } : {}),
    local: Boolean(record.local),
    hasToken: Boolean(record.sshAlias || tokens.get(record.id) || record.encryptedToken),
    persistent: Boolean(record.local || record.sshAlias || record.encryptedToken),
    ...(record.sshAlias ? { sshAlias: record.sshAlias } : {}),
    ...(record.sshTarget ? { sshTarget: record.sshTarget } : {}),
  });
  const persist = async () => {
    await mkdir(userData, { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify([...records.values()].filter((r) => !r.local)), {
      mode: 0o600,
    });
    await rename(temp, path);
  };
  const tokenFor = (record) => {
    if (tokens.has(record.id)) return tokens.get(record.id);
    if (record.encryptedToken) {
      try {
        if (!secure()) throw new Error();
        const token = safeStorage.decryptString(Buffer.from(record.encryptedToken, "base64"));
        tokens.set(record.id, token);
        return token;
      } catch {
        throw new Error("credentialUnavailable");
      }
    }
    return "";
  };
  const probe = async (record, token) => {
    const request = async (path) => {
      const response = await fetchImpl(`${record.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${token ?? ""}` },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new Error(response.status === 401 ? "Authentication failed" : "Server unavailable");
      return response.json();
    };
    await request("/api/v2/session");
    const info = await request("/api/v2/server");
    if (info.apiVersion !== "v2" || typeof info.id !== "string" || !info.id)
      throw new Error("Unsupported server");
    if (record.expectedServerId && record.expectedServerId !== info.id)
      throw new Error("serverChanged");
    return info;
  };
  const activate = async (id) => {
    const record = records.get(id);
    if (!record) throw new Error("Connection not found");
    if (record.local && !record.baseUrl)
      throw new Error(
        "Local server is unavailable. Restart the app or connect to a remote server.",
      );
    const endpoint = record.sshAlias
      ? await resolveSsh(record.sshAlias, record.sshTarget)
      : { baseUrl: record.baseUrl, token: tokenFor(record) };
    const token = endpoint.token;
    const server = await probe({ ...record, baseUrl: endpoint.baseUrl }, token);
    if (active) {
      bindings.get(active.bindingId)?.abort.abort();
      bindings.delete(active.bindingId);
    }
    const bindingId = randomUUID();
    bindings.set(bindingId, { baseUrl: endpoint.baseUrl, token, abort: new AbortController() });
    record.expectedServerId = server.id;
    active = {
      mode: record.local ? "local" : "remote",
      baseUrl: endpoint.baseUrl,
      apiBase: `intrica://app/connections/${bindingId}`,
      bindingId,
      profileId: id,
    };
    return active;
  };
  const save = async (input, sshAlias, sshTarget) => {
    if (
      !input ||
      typeof input.label !== "string" ||
      !input.label.trim() ||
      input.label.length > 200 ||
      typeof input.baseUrl !== "string" ||
      input.baseUrl.length > 2000 ||
      (input.token !== undefined &&
        (typeof input.token !== "string" || input.token.length > 512)) ||
      (input.rememberToken !== undefined && typeof input.rememberToken !== "boolean")
    )
      throw new Error("Invalid connection");
    if (input.id === "local") throw new Error("Built-in connection cannot be edited");
    const old = input.id ? records.get(input.id) : null;
    if (input.id && !old) throw new Error("Connection not found");
    if (old?.sshAlias && old.sshAlias !== sshAlias)
      throw new Error("Manage SSH connections through SSH deployment.");
    const baseUrl = serverOrigin(input.baseUrl);
    if (
      [...records.values()].some(
        (r) => !r.sshAlias && !sshAlias && r.baseUrl === baseUrl && r.id !== input.id,
      )
    )
      throw new Error("duplicateServer");
    if (old?.baseUrl !== baseUrl && input.token === undefined)
      throw new Error("Enter a token for the new server address");
    const token = input.token ?? (old ? tokenFor(old) : "");
    const record = {
      id: input.id ?? randomUUID(),
      label: input.label.trim(),
      baseUrl,
      ...(sshAlias ? { sshAlias } : {}),
      ...(sshTarget ? { sshTarget } : {}),
      ...((old?.baseUrl === baseUrl || (sshAlias && old?.sshAlias === sshAlias)) &&
      old?.expectedServerId
        ? { expectedServerId: old.expectedServerId }
        : {}),
    };
    const server = await probe(record, token);
    record.expectedServerId = server.id;
    if (!sshAlias && token && input.rememberToken !== false && secure())
      record.encryptedToken = safeStorage.encryptString(token).toString("base64");
    records.set(record.id, record);
    if (sshAlias) tokens.delete(record.id);
    else tokens.set(record.id, token);
    await persist();
    return publicRecord(record);
  };
  return {
    get: () => {
      if (!active)
        throw new Error("Local server is unavailable. Open Settings to connect to another server.");
      return active;
    },
    list: () => [...records.values()].map(publicRecord),
    save,
    saveManaged: async ({ alias, baseUrl, token, sshTarget }) => {
      const old = [...records.values()].find((record) => record.sshAlias === alias);
      return save(
        {
          ...(old ? { id: old.id } : {}),
          label: old?.label ?? (sshTarget ? `${sshTarget.username}@${sshTarget.hostname}` : alias),
          baseUrl,
          token,
        },
        alias,
        sshTarget,
      );
    },
    forgetToken: async (id) => {
      const record = records.get(id);
      if (!record || record.local || record.sshAlias)
        throw new Error("This credential cannot be cleared here.");
      delete record.encryptedToken;
      tokens.delete(id);
      if (active?.profileId === id) {
        bindings.get(active.bindingId)?.abort.abort();
        bindings.delete(active.bindingId);
        active = null;
      }
      await persist();
    },
    inspect: async (id) => {
      const record = records.get(id);
      if (!record) throw new Error("Connection not found");
      const endpoint = record.sshAlias
        ? await resolveSsh(record.sshAlias, record.sshTarget)
        : { baseUrl: record.baseUrl, token: tokenFor(record) };
      await probe({ ...record, baseUrl: endpoint.baseUrl }, endpoint.token);
      const request = async (path) => {
        const response = await fetchImpl(`${endpoint.baseUrl}${path}`, {
          headers: { Authorization: `Bearer ${endpoint.token}` },
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? "This server needs an update to support diagnostics."
              : `Diagnostics request failed (${response.status}).`,
          );
        return response.json();
      };
      const [version, diagnostics] = await Promise.all([
        request("/api/v2/settings/version"),
        request("/api/v2/settings/diagnostics"),
      ]);
      return { version, ...diagnostics };
    },
    activate,
    disconnect: (id) => {
      if (active?.profileId !== id) throw new Error("Connection is not active");
      bindings.get(active.bindingId)?.abort.abort();
      bindings.delete(active.bindingId);
      const record = records.get(id);
      if (record?.sshAlias) releaseSsh?.(record.sshAlias);
      active = null;
    },
    remove: async (id) => {
      if (id === "local") throw new Error("Built-in connection cannot be removed");
      const alias = records.get(id)?.sshAlias;
      if (active?.profileId === id) {
        bindings.get(active.bindingId)?.abort.abort();
        bindings.delete(active.bindingId);
        active = null;
      }
      records.delete(id);
      tokens.delete(id);
      if (alias && ![...records.values()].some((record) => record.sshAlias === alias))
        releaseSsh?.(alias);
      await persist();
    },
    async forward(request, bindingId, path) {
      const binding = bindings.get(bindingId);
      if (!binding) return new Response("Connection closed", { status: 410 });
      if (
        !path.startsWith("/api/v2/") ||
        !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(request.method)
      )
        return new Response("Not allowed", { status: 403 });
      const headers = new Headers();
      for (const name of ["content-type", "accept", "accept-language", "range"])
        if (request.headers.has(name)) headers.set(name, request.headers.get(name));
      if (binding.token) headers.set("authorization", `Bearer ${binding.token}`);
      const url = new URL(path, binding.baseUrl);
      if (url.origin !== binding.baseUrl) return new Response("Invalid target", { status: 403 });
      try {
        const response = await fetchImpl(url, {
          method: request.method,
          headers,
          redirect: "error",
          signal: AbortSignal.any([request.signal, binding.abort.signal]),
          ...(!["GET", "HEAD"].includes(request.method)
            ? { body: request.body, duplex: "half" }
            : {}),
        });
        const output = new Headers();
        for (const name of [
          "content-type",
          "content-disposition",
          "content-range",
          "accept-ranges",
          "cache-control",
          "etag",
        ])
          if (response.headers.has(name)) output.set(name, response.headers.get(name));
        output.set("cache-control", "no-store");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: output,
        });
      } catch {
        return new Response("Server unavailable", { status: 502 });
      }
    },
    close() {
      for (const binding of bindings.values()) binding.abort.abort();
      bindings.clear();
      tokens.clear();
    },
  };
}
