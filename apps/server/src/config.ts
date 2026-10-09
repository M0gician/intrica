import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  configFilePath,
  loadFileConfig,
  type ModelConfig,
  resolveModelConfig,
} from "./adapters/model/index.js";
import { type ExecutionLimits, executionLimits } from "./modules/execution/limits.js";
export type ApiConfig = {
  host: string;
  port: number;
  databaseUrl: string;
  dataDir: string;
  webRoot: string;
  accessToken: string;
  serverName: string;
  deployment: "desktop" | "container" | "service" | "source";
  model: ModelConfig | null;
  schemaFile?: string;
  worker: boolean;
  execution?: ExecutionLimits;
};
export function modelConfigFromEnv(env: NodeJS.ProcessEnv) {
  return resolveModelConfig(env, loadFileConfig(configFilePath(env)));
}
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  let root = process.cwd();
  while (!existsSync(join(root, "pnpm-workspace.yaml")) && dirname(root) !== root)
    root = dirname(root);
  const dataDir = resolve(env.DATA_DIR ?? join(root, ".data/v2"));
  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 3001),
    databaseUrl: env.DATABASE_URL ?? "postgres://127.0.0.1:5432/intrica",
    dataDir,
    webRoot: env.INTRICA_WEB_ROOT ?? join(root, "apps/web/dist"),
    accessToken: env.INTRICA_ACCESS_TOKEN?.trim() ?? "",
    serverName: env.INTRICA_SERVER_NAME ?? "Intrica Server",
    deployment: env.INTRICA_DEPLOYMENT === "container" ? "container" : "source",
    model: modelConfigFromEnv(env),
    worker: env.INTRICA_WORKER !== "false",
    execution: executionLimits(env),
    ...(env.INTRICA_SCHEMA_FILE ? { schemaFile: env.INTRICA_SCHEMA_FILE } : {}),
  };
}
export function authenticateConfig(config: ApiConfig) {
  const local = ["127.0.0.1", "localhost", "::1"].includes(config.host);
  if (!local && !config.accessToken.trim())
    throw new Error("非回环监听必须设置非空 INTRICA_ACCESS_TOKEN");
  if (!config.accessToken) {
    const dir = join(config.dataDir, "secrets");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "server-auth");
    try {
      writeFileSync(path, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    config.accessToken = readFileSync(path, "utf8").trim();
  }
  if (!config.accessToken) throw new Error("Server 认证配置无效");
  return config;
}
