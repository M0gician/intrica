import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { AppInstance } from "../app.js";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};
export function registerWebRoutes(app: AppInstance, root?: string) {
  if (!root) return;
  const webRoot = resolve(root);
  app.get("/*", async (request, reply) => {
    const rawPath = request.url.split("?", 1)[0] ?? "/";
    if (rawPath === "/api" || rawPath.startsWith("/api/"))
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "API 路径不存在" } });
    let requested = "";
    try {
      requested = decodeURIComponent(rawPath).replace(/^\//, "");
    } catch {
      requested = "";
    }
    const candidate = resolve(webRoot, requested || "index.html");
    const relativePath = relative(webRoot, candidate);
    const path =
      relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)
        ? candidate
        : resolve(webRoot, "index.html");
    try {
      reply.type(mime[extname(path)] ?? "application/octet-stream");
      return await readFile(path);
    } catch {
      reply.type("text/html; charset=utf-8");
      return readFile(resolve(webRoot, "index.html"));
    }
  });
}
