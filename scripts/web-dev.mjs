import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalBackend } from "../apps/server/runtime.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configuredWebRoot = process.env.INTRICA_WEB_ROOT ?? "apps/web/dist";
const webRoot = resolve(repositoryRoot, configuredWebRoot);
const userData = resolve(repositoryRoot, process.env.INTRICA_WEB_USER_DATA ?? ".data/web");
const host = process.env.HOST?.trim() || "0.0.0.0";
const port = Number(process.env.PORT ?? "3001");
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const remote = !loopbackHosts.has(host);
const accessToken =
  process.env.INTRICA_ACCESS_TOKEN?.trim() || (remote ? randomBytes(24).toString("base64url") : "");

function machineIpv4() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (
        (address.family === "IPv4" || address.family === 4) &&
        !address.internal &&
        !address.address.startsWith("169.254.")
      )
        return address.address;
    }
  }
  return "";
}

const publicHost =
  process.env.INTRICA_PUBLIC_HOST?.trim() ||
  (host === "0.0.0.0" || host === "::" ? machineIpv4() : host.replace(/^\[|\]$/g, ""));

if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("PORT 必须是 0 到 65535 之间的整数");
if (!publicHost)
  throw new Error("无法确定开发机 IP，请通过 INTRICA_PUBLIC_HOST 显式指定可访问的主机名或 IP");
await mkdir(userData, { recursive: true });

const backend = await startLocalBackend({
  userData,
  schemaFile: resolve(repositoryRoot, "db/schema.sql"),
  webRoot,
  host,
  port,
  accessToken,
});

const listeningUrl = new URL(backend.apiUrl);
const urlHost = publicHost.includes(":") ? `[${publicHost}]` : publicHost;
const baseUrl = `http://${urlHost}:${listeningUrl.port}/`;
const directUrl = accessToken ? `${baseUrl}#token=${encodeURIComponent(accessToken)}` : baseUrl;
console.log(`Intrica Web 已启动：${directUrl}`);
console.log("在浏览器打开上面的 URL 即可访问和操控这台开发机上的 Intrica 后端。按 Ctrl+C 停止。\n");

let closing;
let shuttingDown = false;
const close = () => {
  shuttingDown = true;
  closing ??= backend.close();
  return closing;
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void close().finally(() => process.exit(0));
  });
}
process.once("uncaughtException", (error) => {
  if (shuttingDown) {
    process.exit(0);
    return;
  }
  console.error("[intrica:web]", error);
  void close().finally(() => process.exit(1));
});
process.once("unhandledRejection", (error) => {
  if (shuttingDown) {
    process.exit(0);
    return;
  }
  console.error("[intrica:web]", error);
  void close().finally(() => process.exit(1));
});

await new Promise(() => {});
