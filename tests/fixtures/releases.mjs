import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { releaseNames } from "@intrica/releases";

export function releaseManifest(version, content) {
  return {
    format: 2,
    version,
    publishedAt: "2026-10-07T00:00:00.000Z",
    apiVersion: "v2",
    schemaVersion: 10,
    serverImage: `ghcr.io/m0gician/intrica@sha256:${"a".repeat(64)}`,
    assets: releaseNames(version).map((name) => ({
      name,
      size: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    })),
  };
}

export async function releaseServer(t) {
  const bytes = Buffer.from("public installer fixture; never executed");
  const requests = [];
  const state = {
    version: "0.3.0",
    mode: "good",
    manifest: null,
    redirect: null,
    assetRedirect: null,
  };
  const server = createServer((req, res) => {
    requests.push({ path: req.url, headers: req.headers });
    if (state.mode === "missing") return res.writeHead(404).end();
    if (req.url.includes("/latest/"))
      return res
        .writeHead(302, {
          location:
            state.redirect ??
            `https://github.com/M0gician/intrica/releases/download/v${state.version}/${req.url
              .split("/")
              .at(-1)
              .replace(/Intrica-\d+\.\d+\.\d+-/, `Intrica-${state.version}-`)}`,
        })
        .end();
    if (req.url.endsWith("/intrica-update.json")) {
      if (state.mode === "oversized") return res.end(" ".repeat(65537));
      const version = req.url.match(/\/v([^/]+)\//)[1];
      return res.end(JSON.stringify(state.manifest ?? releaseManifest(version, bytes)));
    }
    if (state.mode === "stream") {
      res.write(bytes.subarray(0, 3));
      return;
    }
    if (state.assetRedirect && req.url.endsWith(".dmg"))
      return res.writeHead(302, { location: state.assetRedirect }).end();
    res.end(state.mode === "corrupt" ? Buffer.alloc(bytes.length) : bytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return {
    bytes,
    state,
    requests,
    // Preserve request semantics while routing fixed public URLs to a real local server.
    fetch: (url, options) => fetch(base + new URL(url).pathname, options),
  };
}
