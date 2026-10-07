import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};
export function registerAppProtocol(session, webRoot, connections) {
  const root = resolve(webRoot);
  session.protocol.handle("intrica", async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "app") return new Response("Not found", { status: 404 });
    const route = /^\/connections\/([a-f0-9-]+)(\/api\/v2\/.*)$/.exec(url.pathname);
    if (route) return connections.forward(request, route[1], route[2] + url.search);
    if (request.method !== "GET" || url.pathname.startsWith("/connections/"))
      return new Response("Not found", { status: 404 });
    let path;
    try {
      path = resolve(
        root,
        `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
      );
    } catch {
      return new Response("Invalid path", { status: 400 });
    }
    if (!path.startsWith(root + sep)) return new Response("Not found", { status: 404 });
    try {
      return new Response(await readFile(path), {
        headers: {
          "content-type": mime[extname(path)] ?? "application/octet-stream",
          "content-security-policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http: https:; connect-src 'self'; font-src 'self' data:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}
