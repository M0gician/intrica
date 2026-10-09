import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { DomainError } from "../postgres/database.js";
import type { OwnerHost } from "./owner.js";

// Darwin limits Unix socket paths to 104 bytes. User data paths (especially
// sandbox/temp directories) can exceed that before adding the socket filename.
export const socketPath = (dataDir: string) =>
  join(
    `/tmp/intrica-host-${process.getuid!()}`,
    `${createHash("sha256").update(resolve(dataDir)).digest("hex").slice(0, 32)}.sock`,
  );
export async function startHostServer(dataDir: string, host: OwnerHost) {
  const path = socketPath(dataDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const directory = await lstat(dirname(path));
  if (!directory.isDirectory() || directory.uid !== process.getuid!() || directory.mode & 0o077)
    throw new Error("宿主 socket 目录必须由当前用户独占访问");
  const alive = await new HostClient(dataDir).call("ping", {}).then(
    () => true,
    () => false,
  );
  if (alive) throw new Error("此数据目录已有宿主 Worker，请使用已有 Worker 或独立数据目录");
  await lstat(path)
    .then(async (stat) => {
      if (!stat.isSocket()) throw new Error("宿主 socket 路径已被其他文件占用");
      await unlink(path);
    })
    .catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    let buffer = "";
    socket.setTimeout(30000, () => socket.destroy());
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 128000) {
        socket.destroy();
        return;
      }
      if (!buffer.includes("\n")) return;
      socket.pause();
      void (async () => {
        let streaming = false;
        try {
          const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
          if (request.method === "download") {
            const file = await host.download(request.args.path, request.args.strict === true);
            if (socket.destroyed) {
              file.stream.destroy();
              return;
            }
            streaming = true;
            socket.write(`${JSON.stringify({ ok: true, name: file.name, size: file.size })}\n`);
            await pipeline(file.stream, socket);
            return;
          }
          const result = await host.call(request.method, request.args ?? {});
          socket.end(`${JSON.stringify({ ok: true, result })}\n`);
        } catch (error) {
          if (streaming) {
            socket.destroy();
            return;
          }
          console.error("[host:request]", error instanceof Error ? error.message : "failed");
          socket.end(
            `${JSON.stringify({ ok: false, error: { code: error instanceof DomainError ? error.code : "HOST_ERROR", message: error instanceof DomainError ? error.message : "宿主操作失败" } })}\n`,
          );
        }
      })();
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o600);
  return {
    close: async () => {
      host.close();
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(path).catch(() => {});
    },
  };
}
export class HostClient {
  constructor(readonly dataDir: string) {}
  download(
    path: string,
    signal: AbortSignal,
    strict = false,
  ): Promise<{ name: string; size: number; stream: Socket }> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath(this.dataDir));
      let header = Buffer.alloc(0);
      let receivedHeader = false;
      const abort = () => socket.destroy(new Error("下载已取消"));
      signal.addEventListener("abort", abort, { once: true });
      socket.once("close", () => signal.removeEventListener("abort", abort));
      socket.setTimeout(30000, () => socket.destroy(new Error("下载连接超时")));
      socket.once("error", reject);
      socket.once("connect", () =>
        socket.write(`${JSON.stringify({ method: "download", args: { path, strict } })}\n`),
      );
      const readHeader = (chunk: Buffer) => {
        header = Buffer.concat([header, chunk]);
        const newline = header.indexOf(10);
        if (newline < 0) {
          if (header.length > 65536) socket.destroy(new Error("下载响应无效"));
          return;
        }
        socket.pause();
        socket.removeListener("data", readHeader);
        receivedHeader = true;
        try {
          const meta = JSON.parse(header.subarray(0, newline).toString());
          if (!meta.ok) throw new DomainError(meta.error.code, meta.error.message);
          if (typeof meta.name !== "string" || !Number.isSafeInteger(meta.size) || meta.size < 0)
            throw new Error("下载响应无效");
          if (header.length > newline + 1) socket.unshift(header.subarray(newline + 1));
          resolve({ name: meta.name, size: meta.size, stream: socket });
        } catch (error) {
          reject(error);
          socket.destroy();
        }
      };
      socket.on("data", readHeader);
      socket.once("end", () => {
        if (!receivedHeader) reject(new Error("下载响应不完整"));
      });
      if (signal.aborted) abort();
    });
  }
  call(method: string, args: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath(this.dataDir));
      let buffer = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new DomainError("HOST_UNAVAILABLE", "宿主 Worker 未响应"));
      }, 15000);
      socket.once("connect", () => socket.write(`${JSON.stringify({ method, args })}\n`));
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        if (buffer.length > 32 * 1024 * 1024) {
          socket.destroy();
          reject(new Error("宿主响应过大"));
        }
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(new DomainError("HOST_UNAVAILABLE", `宿主 Worker 不可用：${error.message}`));
      });
      socket.once("end", () => {
        clearTimeout(timer);
        try {
          const response = JSON.parse(buffer);
          response.ok
            ? resolve(response.result)
            : reject(new DomainError(response.error.code, response.error.message));
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}
