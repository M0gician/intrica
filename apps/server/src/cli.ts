import type { BuildServerOptions } from "./app.js";

export function parseServerArgs(argv: string[]): BuildServerOptions {
  const options: BuildServerOptions = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next) throw new Error(`缺少 ${arg} 的值`);
      return next;
    };
    if (arg === "--host") options.host = value();
    else if (arg === "--port") options.port = Number(value());
    else if (arg === "--data-dir") options.dataDir = value();
    else if (arg === "--database-url") options.databaseUrl = value();
    else if (arg === "--web-root") options.webRoot = value();
    else if (arg === "--access-token") options.accessToken = value();
    else if (arg === "--name") options.serverName = value();
    else if (arg === "--no-worker") options.worker = false;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "intrica-server [--host HOST] [--port PORT] [--data-dir DIR] [--web-root DIR] [--access-token TOKEN] [--name NAME] [--no-worker]",
      );
      process.exit(0);
    } else throw new Error(`未知参数：${arg}`);
  }
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
  )
    throw new Error("端口必须是 0-65535 的整数");
  return options;
}
