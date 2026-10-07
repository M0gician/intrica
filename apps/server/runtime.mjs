import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

function portIsOpen(port) {
  return new Promise((resolvePort) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const timer = setTimeout(() => finish(false), 1000);
    const finish = (value) => {
      clearTimeout(timer);
      socket.destroy();
      resolvePort(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function existingPostgres(databaseDir) {
  try {
    const lines = (await readFile(join(databaseDir, "postmaster.pid"), "utf8")).split("\n");
    const pid = Number(lines[0]);
    const port = Number(lines[3]);
    if (!Number.isInteger(pid) || !Number.isInteger(port) || port < 1) return null;
    process.kill(pid, 0);
    return (await portIsOpen(port)) ? { pid, port } : null;
  } catch {
    return null;
  }
}

function withTimeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function importEmbeddedPostgres() {
  // Spawned binaries must live outside ASAR. Use the same entry to resolve the
  // dependency's exit hook; the packed and unpacked copies have separate state.
  let entry = createRequire(import.meta.url).resolve("embedded-postgres");
  if (process.resourcesPath) {
    const unpackedEntry = join(
      process.resourcesPath,
      "app.asar.unpacked/node_modules/embedded-postgres/dist/index.js",
    );
    try {
      await access(unpackedEntry);
      entry = unpackedEntry;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const embedded = await import(pathToFileURL(entry).href);
  // Intrica owns orderly API → Worker → PostgreSQL shutdown. The dependency's
  // async exit handler also runs on synchronous exit, where `done` is absent.
  const exitHook = createRequire(entry)("async-exit-hook");
  for (const event of exitHook.hookedEvents()) exitHook.unhookEvent(event);
  return embedded;
}

/** Development and installed applications share this lifecycle. */
export async function startLocalBackend({
  userData,
  schemaFile,
  webRoot,
  host = "127.0.0.1",
  port = 0,
  accessToken,
  deployment = "desktop",
  serverName,
  databasePassword = "intrica-local",
}) {
  const { default: EmbeddedPostgres } = await importEmbeddedPostgres();
  const { buildServer } = await import("@intrica/server");
  const localAccessToken = accessToken ?? randomUUID();
  const dataRoot = join(userData, "data");
  const databaseDir = join(dataRoot, "postgres");
  await mkdir(dataRoot, { recursive: true });
  const existing = await existingPostgres(databaseDir);
  if (existing)
    throw new Error("本地数据库仍在使用。请正常退出使用此数据目录的 Intrica 实例后重试。");
  const postgresPort = await freePort();
  const postgres = new EmbeddedPostgres({
    databaseDir,
    port: postgresPort,
    user: "intrica",
    password: databasePassword,
    persistent: true,
    postgresFlags: ["-h", "127.0.0.1", "-k", ""],
    onLog: () => {},
    onError: (error) => console.error("[intrica:postgres]", error),
  });
  let api;
  let closing;
  let ownsPostgres = false;
  const close = () => {
    closing ??= (async () => {
      try {
        await api?.close();
      } finally {
        if (ownsPostgres) await withTimeout(postgres.stop(), 10000, "关闭本地数据库");
      }
    })();
    return closing;
  };

  try {
    try {
      await access(join(databaseDir, "PG_VERSION"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const entries = await readdir(databaseDir).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      if (entries.length)
        throw new Error(
          "本地数据库目录已有数据，但缺少 PG_VERSION。请保留目录并检查备份和启动日志。",
        );
      await postgres.initialise();
    }
    ownsPostgres = true;
    await withTimeout(postgres.start(), 30000, "启动本地数据库");
    const admin = postgres.getPgClient("postgres", "127.0.0.1");
    try {
      await withTimeout(admin.connect(), 10000, "连接本地数据库");
      const existing = await withTimeout(
        admin.query("SELECT 1 FROM pg_database WHERE datname = $1", ["intrica"]),
        10000,
        "检查本地数据库",
      );
      if (!existing.rowCount)
        await withTimeout(admin.query('CREATE DATABASE "intrica"'), 10000, "创建本地数据库");
    } finally {
      await admin.end();
    }
    api = await buildServer({
      port,
      host,
      databaseUrl: `postgres://intrica:${encodeURIComponent(databasePassword)}@127.0.0.1:${postgresPort}/intrica`,
      dataDir: dataRoot,
      worker: true,
      schemaFile,
      webRoot,
      accessToken: localAccessToken,
      deployment,
      ...(serverName ? { serverName } : {}),
    });
    const apiUrl = await withTimeout(api.listen({ port, host }), 10000, "监听本地服务");
    return { apiUrl, authToken: localAccessToken, close };
  } catch (error) {
    await close().catch((cleanupError) => console.error("[intrica:cleanup]", cleanupError));
    throw error;
  }
}
