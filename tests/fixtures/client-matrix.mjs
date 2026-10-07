import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalBackend } from "../../apps/server/runtime.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Real isolated API/worker/PostgreSQL instances. The gateway only injects faults. */
export async function createMatrixServer(label) {
  const directory = await mkdtemp(join(tmpdir(), "intrica-client-matrix-"));
  const token = randomUUID();
  let backend;
  let online = true;
  let held;
  const gates = new Set();
  const requests = [];
  const gateway = createServer(async (req, res) => {
    const path = new URL(req.url, "http://fixture").pathname;
    requests.push({ method: req.method, path });
    if ((!online && path.startsWith("/api/")) || !backend) {
      res.writeHead(503).end("Matrix fixture is offline");
      return;
    }
    if (held?.path === path) {
      const current = held;
      held = undefined;
      current.entered();
      await current.wait;
      // A fully received request is not cancellation: only the response closing
      // proves that the downstream client abandoned this held operation.
      if (res.destroyed) return;
    }
    const target = new URL(req.url, backend.apiUrl);
    const upstream = httpRequest(target, { method: req.method, headers: req.headers }, (reply) => {
      res.writeHead(reply.statusCode, reply.headers);
      reply.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.once("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  const start = async () => {
    backend = await startLocalBackend({
      userData: directory,
      schemaFile: join(root, "db/schema.sql"),
      webRoot: join(root, "apps/web/dist"),
      host: "127.0.0.1",
      port: 0,
      accessToken: token,
      deployment: "service",
      serverName: `Matrix ${label}`,
    });
  };
  try {
    await start();
    await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  } catch (error) {
    await backend?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const baseUrl = `http://127.0.0.1:${gateway.address().port}`;
  const call = async (path, method = "GET", body) => {
    const response = await fetch(`${baseUrl}/api/v2/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.ok, true, `${label} API ${path}: ${response.status}`);
    return response.json();
  };
  return {
    label,
    token,
    baseUrl,
    call,
    requests,
    setOnline(value) {
      online = value;
    },
    hold(path) {
      assert.equal(held, undefined, "Only one fault injection may be armed at a time");
      let entered;
      let release;
      const waiting = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Expected fault-injection request was not received: ${path}`)),
          10000,
        );
        entered = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      held = { path: `/api/v2/${path}`, entered, wait, release };
      gates.add(release);
      return {
        waiting,
        release: () => {
          gates.delete(release);
          release();
        },
      };
    },
    async restart() {
      const previous = backend;
      backend = undefined;
      await previous.close();
      await start();
    },
    async close() {
      for (const release of gates) release();
      gateway.closeAllConnections();
      await new Promise((resolve) => gateway.close(resolve));
      await backend?.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** Every assertion uses the actual renderer transport, including Electron's proxy. */
export function matrixClient(page) {
  return (path, method = "GET", body) =>
    page.evaluate(
      async ({ path, method, body }) => {
        const base = window.intricaDesktop
          ? (await window.intricaDesktop.connection.get()).apiBase
          : "";
        const response = await fetch(`${base}/api/v2/${path}`, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        });
        if (!response.ok) throw new Error(`Matrix API ${path}: ${response.status}`);
        return response.json();
      },
      { path, method, body },
    );
}

export async function seedMatrixBoard(call, label) {
  const board = (
    await call("canvases", "POST", {
      // Canvas IDs genuinely collide between independently persisted servers.
      idempotencyKey: "client-matrix-colliding-canvas",
      title: `Matrix board ${label}`,
    })
  ).node;
  const create = async (input) =>
    (
      await call("nodes", "POST", {
        kind: "text",
        parentId: board.id,
        position: { x: 60, y: 100, width: 260, height: 200 },
        ...input,
        idempotencyKey: randomUUID(),
      })
    ).node;
  const marker = `EXACT_CONTENT_${label}_${randomUUID()}`;
  const resource = await create({ title: `Evidence ${label}`, text: marker });
  const agent = await create({
    kind: "agent",
    title: `Matrix agent ${label}`,
    agent: { role: "read", enabled: false, persona: "Matrix draft scope witness." },
    position: { x: 400, y: 100, width: 260, height: 300 },
  });
  return { board, resource, agent, marker };
}

export async function verifyMatrixContent(page, saved, expectedServerId) {
  const call = matrixClient(page);
  assert.equal((await call("server")).id, expectedServerId);
  assert.equal((await call(`nodes/${saved.resource.id}/content`)).node.text, saved.marker);
  const snapshot = await call(`bootstrap?canvasId=${saved.board.id}`);
  assert.ok(
    snapshot.nodes.some((node) => node.id === saved.resource.id && node.text === saved.marker),
  );
  return snapshot;
}

export async function verifyMatrixMedia(page, label) {
  const image =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQMgkTMgljgFAAEA4CcV2GZ44AAAAASUVORK5CYII=";
  const uploaded = await page.evaluate(
    async ({ image, label }) => {
      const base = window.intricaDesktop
        ? (await window.intricaDesktop.connection.get()).apiBase
        : "";
      const form = new FormData();
      form.append(
        "file",
        new Blob([Uint8Array.from(atob(image), (c) => c.charCodeAt(0))], { type: "image/png" }),
        `evidence-${label}.png`,
      );
      const response = await fetch(`${base}/api/v2/assets`, { method: "POST", body: form });
      if (!response.ok) throw new Error(`Upload: ${response.status}`);
      const asset = await response.json();
      const download = await fetch(`${base}/api/v2/assets/${asset.assetId}`);
      return {
        asset,
        status: download.status,
        mime: download.headers.get("content-type"),
        body: btoa(String.fromCharCode(...new Uint8Array(await download.arrayBuffer()))),
      };
    },
    { image, label },
  );
  assert.equal(uploaded.status, 200);
  assert.match(uploaded.mime, /^image\/png/);
  assert.equal(uploaded.body, image, "Media must round-trip exact bytes through the active server");
  return uploaded.asset;
}

export async function verifyMatrixTerminal(page, canvasId) {
  const call = matrixClient(page);
  const workspace = await call(`workspace/root?canvasId=${canvasId}`);
  const session = await call("workspace/terminals", "POST", {
    cwd: workspace.path,
    cols: 80,
    rows: 24,
  });
  try {
    await call(`workspace/terminals/${session.id}/input`, "POST", { data: "pwd\r" });
    const output = await page.evaluate(
      async ({ id, path }) => {
        const base = window.intricaDesktop
          ? (await window.intricaDesktop.connection.get()).apiBase
          : "";
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 10000);
        const decoder = new TextDecoder();
        let output = "";
        try {
          const response = await fetch(`${base}/api/v2/workspace/terminals/${id}/output`, {
            signal: abort.signal,
          });
          if (!response.ok) throw new Error(`Terminal output: ${response.status}`);
          const reader = response.body.getReader();
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            output += decoder.decode(chunk.value);
            if (output.includes(path)) break;
          }
          return output;
        } finally {
          abort.abort();
          clearTimeout(timer);
        }
      },
      { id: session.id, path: workspace.path },
    );
    assert.ok(
      output.includes(workspace.path),
      "Terminal must execute in the active server's workspace",
    );
  } finally {
    await call(`workspace/terminals/${session.id}`, "DELETE");
  }
}
